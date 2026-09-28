import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const workspaceDirectory = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
const cargoTargetPrefix = "openspell-root-authority-target-";
const systemTempCandidates = Object.freeze(["/tmp", "/var/tmp"]);
const image = [
  "docker.io/library/",
  "rust:1.97.1-bookworm",
  "@sha256:",
  "0e2bcaef56d041a4",
  "86784e54104a81ae",
  "be0da44bd03019bd",
  "70bc0401e42e4a97",
].join("");

const commands = Object.freeze({
  check:
    "cargo fmt --all -- --check && cargo check --locked --all-targets --all-features && cargo clippy --locked --all-targets --all-features -- -D warnings && cargo rustdoc --locked --lib --all-features -- -D warnings",
  test: "cargo test --locked --all-targets --all-features",
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageDirectory,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

function versionOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageDirectory,
    encoding: "utf8",
  });
  return result.status === 0 && typeof result.stdout === "string" ? result.stdout : undefined;
}

// Parses "<name> <version> (<commit> <date>)". rustc and rustdoc print a
// shorter commit hash than clippy and rustfmt, so builds match on date and
// commit prefix.
function parseBuild(output, prefix) {
  if (output === undefined || !output.startsWith(prefix)) return undefined;
  const match = /\(([0-9a-f]{7,40}) (\d{4}-\d{2}-\d{2})\)\s*$/u.exec(output);
  if (match === null) return undefined;
  return { commit: match[1], date: match[2] };
}

function sameBuild(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.date === right.date &&
    (left.commit.startsWith(right.commit) || right.commit.startsWith(left.commit))
  );
}

// The local path runs the whole check script, so it needs every tool that
// script uses (rustfmt, clippy and rustdoc as well as rustc and cargo) from
// the pinned toolchain build. Anything less falls back to the container.
function hasPinnedLocalToolchain() {
  const rustc = parseBuild(versionOutput("rustc", ["--version"]), "rustc 1.97.1 ");
  if (rustc === undefined) return false;
  const cargo = versionOutput("cargo", ["--version"]);
  if (cargo === undefined || !cargo.startsWith("cargo 1.97.1 ")) return false;
  const rustdoc = versionOutput("rustdoc", ["--version"]);
  const clippy = versionOutput("cargo", ["clippy", "--version"]);
  const rustfmt = versionOutput("cargo", ["fmt", "--version"]);
  return (
    sameBuild(rustc, parseBuild(rustdoc, "rustdoc 1.97.1 ")) &&
    sameBuild(rustc, parseBuild(clippy, "clippy 0.1.97 ")) &&
    sameBuild(rustc, parseBuild(rustfmt, "rustfmt "))
  );
}

function isWithin(parent, candidate) {
  const relation = relative(parent, candidate);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

function createCargoTargetDirectory() {
  for (const candidate of systemTempCandidates) {
    let resolved;
    try {
      resolved = realpathSync(candidate);
    } catch {
      continue;
    }
    if (isWithin(workspaceDirectory, resolved)) continue;
    try {
      return mkdtempSync(join(resolved, cargoTargetPrefix));
    } catch {
      continue;
    }
  }
  throw new Error("isolated system temporary directory required");
}

export function runCargo(mode) {
  const script = commands[mode];
  if (script === undefined) throw new Error("unsupported cargo mode");

  if (hasPinnedLocalToolchain()) {
    const cargoTargetDirectory = createCargoTargetDirectory();
    try {
      return run("bash", ["-c", script], {
        env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDirectory },
      });
    } finally {
      rmSync(cargoTargetDirectory, { force: true, recursive: true });
    }
  }

  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("linux uid/gid required");
  return run("docker", [
    "run",
    "--rm",
    "--user",
    `${uid}:${gid}`,
    "--env",
    "CARGO_HOME=/cargo",
    "--env",
    "CARGO_TARGET_DIR=/target",
    "--env",
    "TMPDIR=/target",
    "--tmpfs",
    `/cargo:rw,uid=${uid},gid=${gid},mode=0700`,
    "--tmpfs",
    `/target:rw,exec,uid=${uid},gid=${gid},mode=0700`,
    "--volume",
    `${packageDirectory}:/workspace:ro`,
    "--workdir",
    "/workspace",
    image,
    "bash",
    "-c",
    script,
  ]);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  const [mode, ...rest] = process.argv.slice(2);
  if (rest.length !== 0 || (mode !== "check" && mode !== "test")) {
    throw new Error("usage: node scripts/cargo.mjs check|test");
  }
  process.exitCode = runCargo(mode);
}
