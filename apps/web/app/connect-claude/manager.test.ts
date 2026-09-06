import { createElement } from 'react';
import { execFileSync } from 'node:child_process';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  claudeSnippet,
  codexSnippet,
  ConnectClaudeManager,
} from './manager';

const ENDPOINT = 'https://mcp.example.test/mcp';

describe('Connect AI setup safety', () => {
  it('passes a configured URL as one literal shell argument', () => {
    const endpoint = "https://mcp.example.test/mcp?q=one&label='two'&literal=$(printf changed)";
    // The shell function records arguments; no Codex command or network runs.
    const args = execFileSync('sh', ['-c', `codex() { printf '%s\\n' "$@"; };\n${codexSnippet(endpoint)}`], { encoding: 'utf8' }).trimEnd().split('\n');
    expect(args).toEqual(['mcp', 'add', 'openspell', '--url', endpoint, '--bearer-token-env-var', 'WIZARD_ADS_MCP_TOKEN']);
  });

  it('generates secret-free Claude and Codex setup for the configured endpoint', () => {
    const secretValue = ['one-time', '-synthetic', '-secret'].join('');
    const claude = claudeSnippet(ENDPOINT);
    const codex = codexSnippet(ENDPOINT);

    expect(claude).toContain(ENDPOINT);
    expect(claude).toContain('"openspell"');
    expect(claude).not.toContain('"wizard-ads"');
    expect(claude).toContain('Bearer ${WIZARD_ADS_MCP_TOKEN}');
    expect(codex).toContain(`--url '${ENDPOINT}'`);
    expect(codex).toContain('codex mcp add openspell');
    expect(codex).not.toContain('codex mcp add wizard-ads');
    expect(codex).toContain('--bearer-token-env-var WIZARD_ADS_MCP_TOKEN');
    expect(codex.split('\n').every((line) => !line.startsWith('+'))).toBe(true);
    expect(`${claude}\n${codex}`).not.toContain(secretValue);
  });

  it('shows unavailable configuration without snippets and keeps existing-key revocation', () => {
    const markup = renderToStaticMarkup(createElement(ConnectClaudeManager, {
      keys: [{
        id: '22222222-2222-4222-8222-222222222222', label: 'Existing key', keyPrefix: 'masked',
        scope: 'read', profileIds: [], expiresAt: null, revokedAt: null, lastUsedAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
      }], profiles: [], canManage: true, role: 'owner', endpoint: null,
    }));
    expect(markup).toContain('AI connection unavailable');
    expect(markup).not.toContain('data-testid="claude-snippet"');
    expect(markup).not.toContain('data-testid="codex-snippet"');
    expect(markup).toContain('data-testid="revoke-key-22222222-2222-4222-8222-222222222222"');
  });

  it('renders bounded expiry, an explicit profile choice, and legacy key scope honestly', () => {
    const profileId = '11111111-1111-4111-8111-111111111111';
    const markup = renderToStaticMarkup(
      createElement(ConnectClaudeManager, {
        keys: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            label: 'Older key',
            keyPrefix: 'masked',
            scope: 'read',
            profileIds: null,
            expiresAt: null,
            revokedAt: null,
            lastUsedAt: null,
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        profiles: [{ id: profileId, label: 'Synthetic profile' }],
        canManage: true,
        role: 'owner',
        endpoint: ENDPOINT,
      }),
    );

    expect(markup).toContain('data-testid="profile-allowlist"');
    expect(markup).toContain(`data-testid="profile-option-${profileId}"`);
    expect(markup).toContain('value="30" selected=""');
    expect(markup).toContain('Legacy: all profiles');
    expect(markup).toContain('WIZARD_ADS_MCP_TOKEN');
    expect(markup).not.toContain('org-wide');
  });
});
