import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import type { ReactNode } from 'react';

import { GOAL_LENSES } from '@wizard-ads/core';

import { Region } from '@wizard-ads/shared';

import type { ProfileRow } from '../../data/profiles';

import { Shell } from '../settings/frame';

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  TableFrame,
  Toolbar,
} from '../../ui/primitives';

import { page } from '../../ui/tokens';

import { SyncControl } from '../../../app/settings/profiles/sync-control';

import { bulkSetSync, saveSchedule, saveTargets } from '../../../app/settings/profiles/actions';

import { BulkSyncBar, RosterSelectionProvider, RowCheckbox, SelectAllCheckbox } from '../../../app/settings/profiles/roster-bulk';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
  if (data === null) return null;
  switch (data.view) {
    case 'gated': return renderGated(data.props);
    case 'ready': return renderReady(data.props);
  }
}

function renderGated({ result }: Extract<ScreenData, { view: 'gated'; }>['props']) {
  return (<main style={page}>
    <PageHeader title="Profiles" />
    <ScreenState variant="gated" title="Access unavailable" body={<>
      {result.state === 'no-database'
        ? 'DATABASE_URL is not set, so this instance cannot read its own database.'
        : 'Your account is not a member of any organisation yet.'}
    </>} />
  </main>);
}

function renderReady({ context, countLabel, roster, filtered, org, query, sort, mayEditTargets, mayToggleSync, rowIds, visibleRows, pageCount, currentPage, pageHref }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={page}>
    <Shell context={context} current="profiles">
      <PageHeader
        title="Profiles"
        subtitle="One row per Amazon advertising profile. Sync decides whether the worker fetches it at all; the targets below are what the engine optimises against."
        meta={
          <>
            <Badge data-testid="roster-count">
              {countLabel}
              {roster.total > 0
                ? ` · ${Object.entries(roster.regionCounts)
                  .map(([region, count]) => `${region} ${count}`)
                  .join(' · ')}`
                : ''}
            </Badge>
            {filtered ? <Badge tone="info">filtered</Badge> : null}
          </>
        }
      />

      <form method="get">
        <input type="hidden" name="org" value={org.orgId} />
        <Toolbar>
          <Field label="Search" htmlFor="roster-q">
            <Input
              id="roster-q"
              type="search"
              name="q"
              placeholder="name or profile id"
              defaultValue={query.q ?? ''}
              aria-label="Search profiles"
              style={{ width: '15rem' }}
            />
          </Field>
          <Field label="Region" htmlFor="roster-region">
            <Select
              id="roster-region"
              name="region"
              defaultValue={query.region ?? ''}
              aria-label="Region"
              style={{ width: '9rem' }}
            >
              <option value="">All regions</option>
              {Region.options.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Country" htmlFor="roster-country">
            <Select
              id="roster-country"
              name="country"
              defaultValue={query.country ?? ''}
              aria-label="Country"
              style={{ width: '9rem' }}
            >
              <option value="">All countries</option>
              {roster.countries.map((country) => (
                <option key={country} value={country}>
                  {country}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Sync state" htmlFor="roster-sync">
            <Select
              id="roster-sync"
              name="sync"
              defaultValue={query.sync ?? ''}
              aria-label="Sync state"
              style={{ width: '10rem' }}
            >
              <option value="">Any sync state</option>
              <option value="on">Sync on</option>
              <option value="off">Sync off</option>
            </Select>
          </Field>
          <Field label="Sort by" htmlFor="roster-sort">
            <Select
              id="roster-sort"
              name="sort"
              defaultValue={sort}
              aria-label="Sort by"
              style={{ width: '10rem' }}
              data-testid="roster-sort"
            >
              <option value="name">Account name</option>
              <option value="country">Country</option>
              <option value="region">Region</option>
            </Select>
          </Field>
          <Button type="submit">
            Filter
          </Button>
          {/* A link, not a reset: the filter lives in the URL, so clearing it
                means going to the unfiltered URL, not blanking the inputs. */}
          <a className="wa-btn wa-btn--ghost" href={`/settings/profiles?${new URLSearchParams({ org: org.orgId })}`}>
            Clear
          </a>
        </Toolbar>
      </form>

      {!mayEditTargets ? (
        <Banner tone="warn" data-testid="read-only-notice">
          Your role is <strong>{org.role}</strong>: this roster is read-only for you.
        </Banner>
      ) : null}

      <RosterSelectionProvider>
        {mayToggleSync ? <BulkSyncBar orgId={org.orgId} action={bulkSetSync} /> : null}

        <TableFrame data-testid="roster-table">
          <table className="wa-table wa-table--numeric">
            <thead>
              <tr>
                {mayToggleSync ? (
                  <th scope="col">
                    <SelectAllCheckbox profileIds={rowIds} />
                  </th>
                ) : null}
                <th scope="col">Profile</th>
                <th scope="col">Region</th>
                <th scope="col">Country</th>
                <th scope="col">Currency</th>
                <th scope="col">Sync</th>
                <th scope="col">Timezone</th>
                <th scope="col">Sync hour</th>
                <th scope="col">Target ACOS %</th>
                <th scope="col">Target TACOS %</th>
                <th scope="col">Goal lens</th>
                <th scope="col">Monthly budget</th>
                <th scope="col">
                  <span className="wa-sr-only">Save</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((profile) => (
                <ProfileTableRow
                  key={profile.id}
                  profile={profile}
                  orgId={org.orgId}
                  mayEditTargets={mayEditTargets}
                  mayToggleSync={mayToggleSync}
                />
              ))}
            </tbody>
          </table>
        </TableFrame>
      </RosterSelectionProvider>

      {pageCount > 1 ? (
        <nav
          className="wa-row"
          aria-label="Roster pages"
          data-testid="roster-pager"
          style={{ alignItems: 'center', gap: '0.75rem', marginTop: '0.75rem' }}
        >
          {currentPage > 1 ? (
            <a className="wa-btn wa-btn--sm" href={pageHref(currentPage - 1)} rel="prev">
              ← Previous
            </a>
          ) : null}
          <span className="wa-hint">
            Page {currentPage} of {pageCount}
          </span>
          {currentPage < pageCount ? (
            <a className="wa-btn wa-btn--sm" href={pageHref(currentPage + 1)} rel="next">
              Next →
            </a>
          ) : null}
        </nav>
      ) : null}

      {roster.rows.length === 0 ? (
        <div style={{ marginTop: '1rem' }}>
          <EmptyState
            data-testid="roster-empty"
            title="No profiles match"
            body={
              roster.total === 0
                ? 'Nothing has been synced into this organisation yet. Connect Amazon Ads and the OAuth callback lands the roster, one row per profile per region.'
                : 'Every profile is filtered out by the current search. Widen it, or clear the filter to see all ' +
                `${roster.total}.`
            }
            action={
              roster.total === 0 ? (
                <a className="wa-btn wa-btn--sm" href="/settings/connections">
                  Connect Amazon Ads
                </a>
              ) : (
                <a className="wa-btn wa-btn--sm" href={`/settings/profiles?${new URLSearchParams({ org: org.orgId })}`}>
                  Clear the filter
                </a>
              )
            }
          />
        </div>
      ) : null}
    </Shell>
  </main>);
}

function ProfileTableRow({
  orgId,
  profile,
  mayEditTargets,
  mayToggleSync,
}: {
  profile: ProfileRow;
  orgId: string;
  mayEditTargets: boolean;
  mayToggleSync: boolean;
}): ReactNode {
  const formId = `targets-${profile.id}`;
  const scheduleFormId = `schedule-${profile.id}`;
  const label = profile.accountName ?? profile.amazonProfileId;
  return (
    <tr data-testid="profile-row" data-profile-id={profile.id}>
      {mayToggleSync ? (
        <td>
          <RowCheckbox profileId={profile.id} label={label} />
        </td>
      ) : null}
      {/* `min-width` rather than a wrap: an account name wrapping onto three
          lines tripled the row height and, at roster scale, most of the page. */}
      <td style={{ minWidth: '16rem' }}>
        <div style={{ fontWeight: 550 }}>{label}</div>
        <div className="wa-hint">{profile.amazonProfileId}</div>
      </td>
      <td>{profile.region}</td>
      <td>{profile.countryCode}</td>
      <td>{profile.currencyCode}</td>
      <td data-testid="sync-state">
        {mayToggleSync ? (
          <SyncControl orgId={orgId} profileId={profile.id} profileLabel={label} enabled={profile.syncEnabled} />
        ) : (
          <Badge tone={profile.syncEnabled ? 'good' : 'neutral'} dot data-testid="sync-readonly">
            {profile.syncEnabled ? 'on' : 'off'}
          </Badge>
        )}
      </td>
      <td>
        {mayToggleSync ? (
          <Input
            form={scheduleFormId}
            name="timezone"
            defaultValue={profile.timezone}
            aria-label={`Timezone for ${label}`}
            style={{ width: '11rem' }}
            data-testid="field-timezone"
          />
        ) : (
          <span data-testid="field-timezone">{profile.timezone}</span>
        )}
        {profile.timezoneLocked ? (
          <div className="wa-hint" data-testid="timezone-locked">
            pinned
          </div>
        ) : null}
      </td>
      <td>
        {mayToggleSync ? (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <Input
              form={scheduleFormId}
              name="preferredSyncHour"
              type="number"
              min="0"
              max="23"
              step="1"
              placeholder="—"
              defaultValue={profile.preferredSyncHour === null ? '' : String(profile.preferredSyncHour)}
              aria-label={`Preferred sync hour for ${label}`}
              style={{ width: '4.5rem' }}
              data-testid="field-syncHour"
            />
            <form action={saveSchedule} id={scheduleFormId}>
              <input type="hidden" name="profileId" value={profile.id} />
              <input type="hidden" name="orgId" value={orgId} />
              <Button type="submit" size="sm" data-testid="save-schedule">
                Save
              </Button>
            </form>
          </div>
        ) : (
          <span data-testid="field-syncHour">
            {profile.preferredSyncHour === null ? '—' : String(profile.preferredSyncHour)}
          </span>
        )}
      </td>
      <td>
        <Cell
          formId={formId}
          name="targetAcos"
          value={fractionToPercent(profile.targetAcos)}
          editable={mayEditTargets}
        />
      </td>
      <td>
        <Cell
          formId={formId}
          name="targetTotalAcos"
          value={fractionToPercent(profile.targetTotalAcos)}
          editable={mayEditTargets}
        />
      </td>
      <td>
        {mayEditTargets ? (
          <Select
            compact
            form={formId}
            name="goalLens"
            defaultValue={profile.goalLens ?? ''}
            aria-label="Goal lens"
            style={{ width: '9rem' }}
            data-testid="field-goalLens"
          >
            <option value="">—</option>
            {Object.entries(GOAL_LENSES).map(([key, lens]) => (
              <option key={key} value={key}>
                {lens.label}
              </option>
            ))}
          </Select>
        ) : (
          <span data-testid="field-goalLens">{profile.goalLens ?? '—'}</span>
        )}
      </td>
      <td>
        <Cell
          formId={formId}
          name="monthlyBudget"
          value={profile.monthlyBudget === null ? '' : String(profile.monthlyBudget)}
          editable={mayEditTargets}
        />
      </td>
      <td>
        {mayEditTargets ? (
          <form action={saveTargets} id={formId}>
            <input type="hidden" name="profileId" value={profile.id} />
            <input type="hidden" name="orgId" value={orgId} />
            <Button type="submit" size="sm" data-testid="save-targets">
              Save
            </Button>
          </form>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * One number, editable or not.
 *
 * The inputs live outside the `<form>` element and reference it with the `form`
 * attribute, because a form cannot span table cells in valid HTML and a row of
 * inputs that silently fails to submit is a worse bug than a slightly unusual
 * attribute.
 */
function Cell({
  formId,
  name,
  value,
  editable,
}: {
  formId: string;
  name: string;
  value: string;
  editable: boolean;
}): ReactNode {
  if (!editable) {
    return <span data-testid={`field-${name}`}>{value === '' ? '—' : value}</span>;
  }
  return (
    <Input
      form={formId}
      name={name}
      type="number"
      step="0.01"
      min="0"
      defaultValue={value}
      aria-label={name}
      style={{ width: '6.5rem' }}
      data-testid={`field-${name}`}
    />
  );
}

function fractionToPercent(value: number | null): string {
  if (value === null) return '';
  return String(Number((value * 100).toFixed(2)));
}

export default function ScreenView({ data }: { data: ScreenData }) {
  if (data === null) return null;
  return <ScreenSurface title="Profiles">{ScreenContent({ data })}</ScreenSurface>;
}
