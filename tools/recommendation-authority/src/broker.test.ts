import { describe, expect, it, vi } from 'vitest';
import { parseAuthorityCommand, brokerResult } from './command.js';
import { runAuthorityBroker, type BrokerPorts } from './broker.js';
import { executeAuthority, type AuthorityConnection } from './database.js';

const a = 'a'.repeat(40); const b = 'b'.repeat(40);
const sqlRow = { decision: 'blocked', protocol: 'legacy', admission: 'blocked', epoch: '1', authorized_revision: null, unresolved: 0 };

describe('fixed authority command and one-shot execution', () => {
  it('rejects malformed commands before any credential or connection work', async () => {
    const ports = { verifyInstallation: vi.fn(), loadCredential: vi.fn(), connect: vi.fn(), execute: vi.fn() };
    const invalid = [[], ['block','0','-',a,'extra'], ['query','0','-',a], ['block','01','-',a],
      ['block','-1','-',a], ['block','9007199254740992','-',a], ['block','1e2','-',a],
      ['block','0','-',a.toUpperCase()], ['activate','0',a,a], ['rebind','0',a,a], ['authorize','0',a,b],
      ['block','0','bad',a]];
    for (const args of invalid) await expect(runAuthorityBroker(args, ports)).rejects.toThrow();
    expect(Object.values(ports).every((mock) => mock.mock.calls.length === 0)).toBe(true);
  });

  it('accepts only exact counted SQL results', () => {
    expect(brokerResult([sqlRow], 'block')).toEqual({ decision: 'blocked', protocol: 'legacy', admission: 'blocked', epoch: 1, authorizedRevision: null, unresolved: 0 });
    for (const rows of [[], [sqlRow, sqlRow], [{ ...sqlRow, secret: 'extra' }], [{ ...sqlRow, epoch: '9007199254740992' }],
      [{ ...sqlRow, unresolved: -1 }], [{ ...sqlRow, decision: 'authorized' }]]) {
      expect(() => brokerResult(rows, 'block')).toThrow();
    }
  });

  it.each(['connect', 'query', 'commit', 'success'] as const)('never repeats the CAS after %s outcome', async (outcome) => {
    let casCalls = 0; let commits = 0;
    const statements: string[] = [];
    const transaction = async (strings: TemplateStringsArray) => {
      const statement = strings.join('?'); statements.push(statement);
      if (statement.includes('block_recommendation_admission')) {
        casCalls += 1;
        if (outcome === 'query') throw new Error('synthetic query failure');
        return [sqlRow];
      }
      return [];
    };
    const connection = {
      async begin(callback: (transaction: unknown) => Promise<unknown>) {
        const result = await callback(transaction);
        commits += 1;
        if (outcome === 'commit') throw new Error('synthetic lost commit response');
        return result;
      },
      end: vi.fn(async () => {}),
    } as unknown as AuthorityConnection;
    const ports: BrokerPorts = {
      verifyInstallation: vi.fn(async () => {}), loadCredential: vi.fn(async () => 'synthetic'),
      connect: vi.fn(() => { if (outcome === 'connect') throw new Error('synthetic connect failure'); return connection; }),
      execute: executeAuthority,
    };
    const promise = runAuthorityBroker(['block','0','-',a], ports);
    if (outcome === 'success') expect(await promise).toMatchObject({ decision: 'blocked', epoch: 1 });
    else await expect(promise).rejects.toThrow();
    expect(casCalls).toBe(outcome === 'connect' ? 0 : 1);
    expect(commits).toBe(outcome === 'commit' || outcome === 'success' ? 1 : 0);
    expect(connection.end).toHaveBeenCalledTimes(outcome === 'connect' ? 0 : 1);
    expect(ports.loadCredential).toHaveBeenCalledTimes(1);
    expect(statements.filter((statement) => statement.startsWith('set local role'))).toHaveLength(outcome === 'connect' ? 0 : 1);
  });

  it('maps every operation to its own fixed parameterized statement', async () => {
    const invocations: { statement: string; values: unknown[] }[] = [];
    for (const args of [['block','1','-',a], ['activate','1','-',a], ['rebind','1',a,b], ['authorize','1',a,a]]) {
      const command = parseAuthorityCommand(args);
      const transaction = async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join('').includes('select * from public.')) invocations.push({ statement: strings.join('?'), values });
        return [{ ...sqlRow, decision: 'stale_epoch' }];
      };
      await executeAuthority({ begin: (callback: (sql: unknown) => unknown) => callback(transaction) } as unknown as AuthorityConnection, command);
    }
    expect(invocations).toEqual([
      { statement: 'select * from public.block_recommendation_admission(?::bigint)', values: [1] },
      { statement: 'select * from public.activate_recommendation_fenced_claims(?::bigint,?::text)', values: [1,a] },
      { statement: 'select * from public.rebind_recommendation_fenced_revision(?::bigint,?::text,?::text)', values: [1,a,b] },
      { statement: 'select * from public.authorize_recommendation_scoped_admission(?::bigint,?::text)', values: [1,a] },
    ]);
  });
});
