/**
 * The tag colour boundary.
 *
 * `tags-route.test.ts` proves the routes never leak across a tenant. This
 * proves the other half of the boundary: the colour column used to accept any
 * string the caller sent, so the product rendered hues that are not in the
 * palette and nothing could tell a brand colour from a typo.
 *
 * Two directions, and they are deliberately asymmetric. A *write* is refused
 * unless it names a `TagColor`. A *read* of a row written before the contract
 * existed still succeeds, and the swatch resolver reports it as neutral rather
 * than throwing — a legacy row is a display question, never an error.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { TAG_COLORS } from '@wizard-ads/shared';
import { GET, POST } from './route.js';
import { PATCH } from './[tagId]/route.js';
import { tagSwatchColor } from '../../tags/colors.js';

const available = await databaseAvailable();
const USER = '8e8e8e8e-8e8e-4e8e-8e8e-8e8e8e8e8e8e';
const BRIDGE_SECRET = 'synthetic-tag-colour-bridge-secret';

describe('tag swatch resolution', () => {
  it('resolves every contract colour to its own brand token', () => {
    const resolved = TAG_COLORS.map((color) => tagSwatchColor(color));
    // One token per colour, and no two colours share one: a swatch set whose
    // members collide is not a swatch set.
    expect(new Set(resolved).size).toBe(TAG_COLORS.length);
    for (const token of resolved) expect(token).toMatch(/^var\(--wa-[a-z0-9-]+\)$/);
  });

  it('reports an absent, legacy, or off-contract colour as the neutral swatch', () => {
    const neutral = tagSwatchColor(null);
    expect(neutral).toBe('var(--wa-series-3)');
    // Exactly the shapes the column already holds: a picker hex, a CSS name,
    // and an empty string. None of them throws, and none of them paints.
    for (const stored of ['#2563eb', '#FD4807', 'rebeccapurple', '']) {
      expect(tagSwatchColor(stored)).toBe(neutral);
    }
  });
});

describe.skipIf(!available)('tag colour at the API boundary', () => {
  let database: TestDatabase;
  let orgId: string;
  const previous = {
    databaseUrl: process.env['DATABASE_URL'],
    bridgeSecret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'],
    bridgeEnabled: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'],
  };

  const headers = () => ({
    'content-type': 'application/json',
    'x-wizard-ads-auth-bridge': BRIDGE_SECRET,
    'x-wizard-ads-user-id': USER,
    'x-wizard-ads-org-id': orgId,
  });
  const create = (body: unknown) =>
    POST(
      new Request('http://localhost/api/tags', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      }),
    );
  const patch = (tagId: string, body: unknown) =>
    PATCH(
      new Request(`http://localhost/api/tags/${tagId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ tagId }) },
    );

  beforeAll(async () => {
    database = await createTestDatabase('wp211_tag_colour');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('tag-colour-tenant', ${USER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    process.env['DATABASE_URL'] = database.connectionString;
    process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = BRIDGE_SECRET;
    process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
  }, 60_000);

  afterAll(async () => {
    if (previous.databaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previous.databaseUrl;
    if (previous.bridgeSecret === undefined) delete process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'];
    else process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = previous.bridgeSecret;
    if (previous.bridgeEnabled === undefined) delete process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'];
    else process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = previous.bridgeEnabled;
    await database?.drop();
  });

  it('refuses an off-contract colour on create, and stores nothing', async () => {
    const refused = await create({ name: 'Off palette', color: '#2563eb' });
    expect(refused.status).toBe(400);
    const { error } = (await refused.json()) as { error: string };
    expect(error).toContain('signal');

    const [row] = await database.sql<{ count: string }[]>`
      select count(*)::text as count from public.tags
       where org_id = ${orgId} and name = 'Off palette'
    `;
    expect(row?.count).toBe('0');
  });

  it('refuses every off-contract shape a caller can send', async () => {
    const rejected = ['#FD4807', 'SIGNAL', 'signal ', 'purple', '', 42, true, {}];
    const statuses = await Promise.all(
      rejected.map(async (color, index) =>
        (await create({ name: `Rejected ${index}`, color })).status,
      ),
    );
    expect(statuses).toEqual(rejected.map(() => 400));

    const [row] = await database.sql<{ count: string }[]>`
      select count(*)::text as count from public.tags
       where org_id = ${orgId} and name like 'Rejected %'
    `;
    expect(row?.count).toBe('0');
  });

  it('accepts every colour in the contract and stores the name it was given', async () => {
    const accepted = await Promise.all(
      TAG_COLORS.map(async (color) => {
        const response = await create({ name: `Accepted ${color}`, color });
        const body = (await response.json()) as { tag?: { color: string | null } };
        return { status: response.status, color: body.tag?.color };
      }),
    );
    // Counted against the input, not merely "no failures".
    expect(accepted).toEqual(TAG_COLORS.map((color) => ({ status: 201, color })));
  });

  it('accepts an absent colour and refuses an off-contract update', async () => {
    const created = await create({ name: 'Uncoloured', color: null });
    expect(created.status).toBe(201);
    const { tag } = (await created.json()) as { tag: { id: string; color: string | null } };
    expect(tag.color).toBeNull();

    expect((await patch(tag.id, { color: '#123456' })).status).toBe(400);
    expect((await patch(tag.id, { color: 'indigo' })).status).toBe(200);

    const [row] = await database.sql<{ color: string | null }[]>`
      select color from public.tags where id = ${tag.id}
    `;
    expect(row?.color).toBe('indigo');
  });

  it('still lists a row written before the contract, as the neutral swatch', async () => {
    const [legacy] = await database.sql<{ id: string }[]>`
      insert into public.tags (org_id, name, slug, color)
      values (${orgId}, 'Legacy hue', 'legacy-hue', '#2563eb')
      returning id
    `;
    const listed = await GET(new Request('http://localhost/api/tags', { headers: headers() }));
    expect(listed.status).toBe(200);
    const { tags } = (await listed.json()) as { tags: { id: string; color: string | null }[] };
    const row = tags.find((node) => node.id === legacy?.id);
    // The stored value survives the read untouched; the swatch is neutral.
    expect(row?.color).toBe('#2563eb');
    expect(tagSwatchColor(row?.color ?? null)).toBe('var(--wa-series-3)');

    // And the row stays *usable*: a rename omits `color`, which must leave the
    // legacy value alone rather than clearing it. Without this the only way to
    // rename a pre-contract tag would be to recolour it, and an operator who
    // renamed one would silently lose its colour on the way through.
    const renamed = await patch(legacy?.id ?? '', { name: 'Legacy renamed' });
    expect(renamed.status).toBe(200);
    const [after] = await database.sql<{ name: string; color: string | null }[]>`
      select name, color from public.tags where id = ${legacy?.id ?? null}
    `;
    expect(after).toEqual({ name: 'Legacy renamed', color: '#2563eb' });
  });
});
