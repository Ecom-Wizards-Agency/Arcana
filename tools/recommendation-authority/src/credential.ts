import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

export const CREDENTIAL_PATH = '/etc/credstore.encrypted/openspell-recommendation-authority-database-url';
const DECRYPT = '/usr/bin/systemd-creds';
const MAX_CREDENTIAL_BYTES = 8192;

/** Driver URL startup options must not override the broker's fixed timeouts. */
export function validateAuthorityDatabaseUrl(raw: string): string {
  if (!/^postgres(?:ql)?:\/\/[^\s\0]{1,8180}$/u.test(raw)) throw new Error('Authority credential unavailable');
  const url = new URL(raw);
  if (!url.hostname || !url.username || !url.password || url.hash
    || [...url.searchParams.keys()].some((key) => key !== 'sslmode')
    || url.searchParams.getAll('sslmode').length > 1
    || (url.searchParams.has('sslmode') && !['disable', 'require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode')!))) {
    throw new Error('Authority credential unavailable');
  }
  return raw;
}

export interface Metadata {
  uid: number; gid: number; mode: number;
  isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean;
}

/** Check every path component without following a symlink. Test seam is internal. */
export async function assertRootPath(path: string, kind: 'directory' | 'file' | 'credential',
  inspect: (path: string) => Promise<Metadata> = lstat): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0') || path.includes('/../') || path.includes('/./')) {
    throw new Error('Unsafe authority path');
  }
  let current = path;
  let first = true;
  for (;;) {
    const metadata = await inspect(current);
    const permissions = metadata.mode & 0o7777;
    if (metadata.uid !== 0 || metadata.gid !== 0 || metadata.isSymbolicLink()
      || (permissions & 0o7022) !== 0
      || (!(first && kind !== 'directory') && !metadata.isDirectory())
      || (first && kind !== 'directory' && !metadata.isFile())
      || (first && kind === 'credential' && permissions !== 0o400 && permissions !== 0o600)) {
      throw new Error('Unsafe authority path');
    }
    if (current === '/') break;
    current = dirname(current);
    first = false;
  }
}

/** Linux's fixed shell/env may use root-owned usr-merge links. Inspect both the
 * alias namespace and every component of the fully resolved executable path. */
export async function assertLauncherSystemExecutable(path: '/bin/sh' | '/usr/bin/env'): Promise<void> {
  let current: string = path;
  for (;;) {
    const metadata = await lstat(current);
    if (metadata.uid !== 0 || metadata.gid !== 0
      || (!metadata.isSymbolicLink() && (metadata.mode & 0o7022) !== 0)) {
      throw new Error('Unsafe authority launcher executable');
    }
    if (current === '/') break;
    current = dirname(current);
  }
  const resolved = await realpath(path);
  await assertRootPath(resolved, 'file');
  if (((await lstat(resolved)).mode & 0o7777) !== 0o755) throw new Error('Unsafe authority launcher executable');
}

/** No plaintext file, caller path, inherited environment, shell, or secret argv. */
export async function loadAuthorityCredential(): Promise<string> {
  await assertRootPath(CREDENTIAL_PATH, 'credential');
  await assertRootPath(DECRYPT, 'file');
  return new Promise((resolve, reject) => {
    const child = spawn(DECRYPT, ['decrypt', CREDENTIAL_PATH, '-'], {
      env: {}, cwd: '/', stdio: ['ignore', 'pipe', 'ignore'], shell: false,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const refuse = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(refuse, 5000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CREDENTIAL_BYTES) { refuse(); return; }
      if (!failed) chunks.push(chunk);
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Authority credential unavailable')); });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (failed || status !== 0) { reject(new Error('Authority credential unavailable')); return; }
      const credential = Buffer.concat(chunks).toString('utf8').trim();
      for (const chunk of chunks) chunk.fill(0);
      try { resolve(validateAuthorityDatabaseUrl(credential)); }
      catch { reject(new Error('Authority credential unavailable')); }
    });
  });
}
