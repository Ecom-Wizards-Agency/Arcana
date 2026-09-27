// @vitest-environment jsdom
import { createElement } from 'react';
import { execFileSync } from 'node:child_process';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_KEY_SCOPE_DESCRIPTIONS } from '@wizard-ads/shared';
import {
  claudeSnippet,
  codexSnippet,
  ConnectClaudeManager,
  KEY_CLASSES,
} from './manager';

const ENDPOINT = 'https://mcp.example.test/mcp';

describe('Connect AI setup safety', () => {
  it('passes a configured URL as one literal shell argument', () => {
    const endpoint = "https://mcp.example.test/mcp?q=one&label='two'&literal=$(printf changed)";
    // The shell function records arguments; no Codex command or network runs.
    const args = execFileSync('sh', ['-c', `codex() { printf '%s\\n' "$@"; };\n${codexSnippet(endpoint)}`], { encoding: 'utf8' }).trimEnd().split('\n');
    expect(args).toEqual(['mcp', 'add', 'arcana', '--url', endpoint, '--bearer-token-env-var', 'WIZARD_ADS_MCP_TOKEN']);
  });

  it('generates secret-free Claude and Codex setup for the configured endpoint', () => {
    const secretValue = ['one-time', '-synthetic', '-secret'].join('');
    const claude = claudeSnippet(ENDPOINT);
    const codex = codexSnippet(ENDPOINT);

    expect(claude).toContain(ENDPOINT);
    expect(claude).toContain('"arcana"');
    expect(claude).not.toContain('"wizard-ads"');
    expect(claude).toContain('Bearer ${WIZARD_ADS_MCP_TOKEN}');
    expect(codex).toContain(`--url '${ENDPOINT}'`);
    expect(codex).toContain('codex mcp add arcana');
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

describe('key classes', () => {
  const profileId = '11111111-1111-4111-8111-111111111111';
  const creatorKey = {
    id: '33333333-3333-4333-8333-333333333333', label: 'Skill runner', keyPrefix: 'masked', scope: 'creator:write' as const,
    profileIds: [], expiresAt: null, revokedAt: null, lastUsedAt: null, createdAt: '2026-09-27T00:00:00.000Z',
  };
  const readKey = { ...creatorKey, id: '44444444-4444-4444-8444-444444444444', label: 'Laptop', scope: 'read' as const, profileIds: [profileId] };
  afterEach(() => { vi.unstubAllGlobals(); });

  it('offers owners and admins read and Creator Connections write, each with its one-line description', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(createElement(ConnectClaudeManager, {
      keys: [], profiles: [{ id: profileId, label: 'Synthetic profile' }], canManage: true, role: 'admin', endpoint: ENDPOINT,
    }));
    const radios = [...host.querySelectorAll<HTMLInputElement>('[data-testid="key-class"] input[type="radio"]')];
    expect(radios.map((radio) => [radio.value, radio.checked])).toEqual([['read', true], ['creator:write', false]]);
    expect(KEY_CLASSES.map((option) => host.querySelector(`[data-testid="key-class-description-${option.scope}"]`)?.textContent))
      .toEqual([MCP_KEY_SCOPE_DESCRIPTIONS.read, MCP_KEY_SCOPE_DESCRIPTIONS['creator:write']]);
    expect(host.querySelectorAll('[data-testid="profile-allowlist"]')).toHaveLength(1);
    expect(host.textContent).not.toContain(MCP_KEY_SCOPE_DESCRIPTIONS.write);
  });

  it('keeps analysts and viewers out of issuing any class', () => {
    for (const role of ['analyst', 'viewer']) {
      const markup = renderToStaticMarkup(createElement(ConnectClaudeManager, {
        keys: [creatorKey], profiles: [{ id: profileId, label: 'Synthetic profile' }], canManage: false, role, endpoint: ENDPOINT,
      }));
      expect(markup).toContain('data-testid="issue-forbidden"');
      expect(markup).not.toContain('data-testid="key-class"');
      expect(markup).not.toContain('data-testid="issue-key"');
    }
  });

  it('lists each key with its class description, and no profiles as a creator:write key\'s reach', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(createElement(ConnectClaudeManager, {
      keys: [creatorKey, readKey], profiles: [{ id: profileId, label: 'Synthetic profile' }], canManage: true, role: 'owner', endpoint: ENDPOINT,
    }));
    const rows = [...host.querySelectorAll('[data-testid="key-row"]')];
    expect(rows).toHaveLength(2);
    const scopes = rows.map((row) => row.querySelector('[data-testid="key-scope"]'));
    expect(scopes.map((cell) => cell?.getAttribute('data-scope'))).toEqual(['creator:write', 'read']);
    expect(scopes[0]?.textContent).toBe(`Creator Connections write${MCP_KEY_SCOPE_DESCRIPTIONS['creator:write']}`);
    expect(scopes[1]?.textContent).toBe(`Read analytics${MCP_KEY_SCOPE_DESCRIPTIONS.read}`);
    expect(rows[0]?.textContent).toContain('None: writes creator records only');
    expect(rows[0]?.textContent).not.toContain('No profiles');
    expect(rows[1]?.textContent).toContain('Synthetic profile');
  });

  it('issues a creator:write key without the profile picker and sends no profiles', async () => {
    const fetchMock = vi.fn(async () => Response.json({ key: creatorKey, token: 'wza_synthetic-one-time' }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(createElement(ConnectClaudeManager, { keys: [], profiles: [], canManage: true, role: 'owner', endpoint: ENDPOINT }));
    // With no profile connected a read key cannot be issued.
    expect((screen.getByTestId('issue-key') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('key-class-creator:write'));
    expect(view.container.querySelectorAll('[data-testid="profile-allowlist"]')).toHaveLength(0);
    expect(screen.getByTestId('creator-write-no-profiles').textContent).toContain('takes no profile allowlist');
    expect((screen.getByTestId('issue-key') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByTestId('key-label-input'), { target: { value: ' Skill runner ' } });
    await act(async () => { fireEvent.click(screen.getByTestId('issue-key')); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/mcp-keys');
    expect(JSON.parse(String(init.body))).toEqual({ label: 'Skill runner', scope: 'creator:write', expiresInDays: 30 });
    expect(screen.getByTestId('issued-token').textContent).toBe('wza_synthetic-one-time');
    expect(view.container.querySelectorAll('[data-testid="key-row"]')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('key-class-read'));
    expect(view.container.querySelectorAll('[data-testid="profile-allowlist"]')).toHaveLength(1);
    view.unmount();
  });
});
