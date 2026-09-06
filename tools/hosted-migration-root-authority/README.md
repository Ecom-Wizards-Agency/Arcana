# Hosted migration root authority

A Linux Rust library and offline test harness for private journal records, fixed
IPC framing and single-use approval-ticket transitions. It is source-only: there
is no public API, executable, listener, production signer, policy loader, clock or
entropy source, state-directory constructor, or deployment entrypoint. It cannot
spawn a process, use the network, connect to a database, select a hosted project or
load a production credential. Passing tests does not create operational authority.

## Maintained source contract

| Source | Responsibility |
| --- | --- |
| [src/lib.rs](src/lib.rs) | Private module boundary and `forbid(unsafe_code)` |
| [src/canonical.rs](src/canonical.rs), [src/records.rs](src/records.rs) | Canonical byte records and validation |
| [src/state.rs](src/state.rs) | Allowed approval/consumption/terminal transitions |
| [src/journal.rs](src/journal.rs), [journal/storage.rs](src/journal/storage.rs) | Durable journal custody and storage verification |
| [src/ipc.rs](src/ipc.rs), [src/protocol.rs](src/protocol.rs) | Separate operator/supervisor peer and message boundaries |
| [src/crypto.rs](src/crypto.rs) | Signature verification and internal signing contract |

The supervisor cannot issue its own approval. Reuse, mismatched identity, malformed
records and uncertain journal outcomes fail closed. Preserve the private
constructors and verified proof types; a convenience public constructor would
change the authority boundary. Tests, including corruption and policy-matrix
tests, define the supported transition cases. The two committed golden JSON files
and the cross-oracle checks are public test inputs and must remain in this package.

## Run the offline checks

```bash
pnpm --filter @wizard-ads/hosted-migration-root-authority typecheck
pnpm --filter @wizard-ads/hosted-migration-root-authority test
```

Use the package scripts: [scripts/cargo.mjs](scripts/cargo.mjs) enforces the pinned
Rust toolchain or pinned container fallback, and [scripts/test.mjs](scripts/test.mjs)
runs both Rust and TypeScript checks. Keep `Cargo.lock`, `rust-toolchain.toml`, the
wrappers and the boundary tests together. A future executable or production
integration needs its own reviewed contract and scoped operator authorization;
this library does not provide an installation shortcut or a production command.
