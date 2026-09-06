import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), lstat: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({ lstat: mocks.lstat }));
import { CREDENTIAL_PATH, loadAuthorityCredential } from './credential.js';

describe('actual fixed credential loader boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lstat.mockImplementation(async (path: string) => ({ uid: 0, gid: 0,
      mode: path === CREDENTIAL_PATH ? 0o600 : 0o755,
      isSymbolicLink: () => false,
      isFile: () => path === CREDENTIAL_PATH || path === '/usr/bin/systemd-creds',
      isDirectory: () => path !== CREDENTIAL_PATH && path !== '/usr/bin/systemd-creds',
    }));
  });
  function processOutput(output: string, status = 0) {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => { child.stdout.write(output); child.emit('close', status); });
      return child;
    });
    return child;
  }

  it('decrypts only the fixed path through a bounded private pipe and empty environment', async () => {
    const secret = `postgres://${['synthetic', 'operator'].join('_')}:test@127.0.0.1/disposable`;
    processOutput(secret);
    expect(await loadAuthorityCredential()).toBe(secret);
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith('/usr/bin/systemd-creds', ['decrypt', CREDENTIAL_PATH, '-'], {
      env: {}, cwd: '/', stdio: ['ignore', 'pipe', 'ignore'], shell: false,
    });
    expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain(secret);
  });

  it('refuses unsafe paths before decrypting and suppresses oversized/error content', async () => {
    mocks.lstat.mockRejectedValueOnce(new Error('unavailable'));
    await expect(loadAuthorityCredential()).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
    const child = processOutput('x'.repeat(8193));
    await expect(loadAuthorityCredential()).rejects.toThrow('Authority credential unavailable');
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    processOutput('synthetic-decryption-error-must-not-escape', 1);
    await expect(loadAuthorityCredential()).rejects.toThrow(/^Authority credential unavailable$/u);
  });
});
