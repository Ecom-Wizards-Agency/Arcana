import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)
      ? [path]
      : [];
  }));
  return nested.flat();
}

describe('invite-only identity boundary', () => {
  it('requires provider email verification instead of creating preconfirmed accounts in web', async () => {
    const webRoot = process.cwd();
    const files = [
      ...(await sourceFiles(resolve(webRoot, 'app'))),
      ...(await sourceFiles(resolve(webRoot, 'src'))),
    ];
    const sources = await Promise.all(files.map(async (path) => ({
      path: relative(webRoot, path),
      source: await readFile(path, 'utf8'),
    })));
    expect(
      sources.filter(({ source }) => source.includes('auth.admin.createUser')).map(({ path }) => path),
    ).toEqual([]);
    expect(sources.some(({ source }) => /email_confirm\s*:\s*true/.test(source))).toBe(false);

    const login = sources.find(({ path }) => path === join('app', 'login', 'actions.ts'))?.source;
    expect(login).toContain('auth.signInWithPassword');
    expect(sources.some(({ source }) => source.includes('.signInWithOtp('))).toBe(false);
    expect(sources.some(({ source }) => source.includes('.signUp('))).toBe(false);

    const localProviderConfig = await readFile(resolve(webRoot, '../../supabase/config.toml'), 'utf8');
    expect(localProviderConfig).toMatch(/^enable_signup = false$/m);
  });
});
