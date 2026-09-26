'use client';
import { useMemo, useState } from 'react';
import { FLAG_ISSUES, flagIssue, groupFlagsByIssue, type FlagContext, type FlagIssue, type Severity } from '@wizard-ads/core';

export interface HomeFlags {
  /** Raised flags, most severe first; pacing leads when it fires. */
  active: FlagContext[];
  /** Findings the rules noted but deliberately did not raise. */
  suppressed: FlagContext[];
  /** Signals held back by the evidence floor. */
  flooredCount: number;
}

type EntityKind = 'campaign' | 'account';
const SEVERITIES: readonly Severity[] = ['critical', 'alert', 'warn', 'info'];
const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', alert: 'Alert', warn: 'Warn', info: 'Info' };

function entityKind(item: FlagContext): EntityKind {
  return item.campaignId === null ? 'account' : 'campaign';
}

function tone(severity: Severity): 'bad' | 'warn' | 'neutral' {
  return severity === 'info' ? 'neutral' : severity === 'warn' ? 'warn' : 'bad';
}

function plural(count: number, singular: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : many}`;
}

export function flagEntityHref(item: FlagContext, profileId: string, period: { start: string; end: string }): string {
  const query = new URLSearchParams({ profile: profileId, entity: 'campaigns' });
  if (item.campaignId !== null) query.set('campaign', item.campaignId);
  query.set('from', period.start);
  query.set('to', period.end);
  return `/grid?${query}`;
}

function evidenceLine(item: FlagContext): string {
  const { window, impressions, days } = item.evidence;
  const traffic = impressions === null ? 'impressions not reported' : plural(impressions, 'impression', 'impressions');
  const daysText = item.family === 'pacing' ? plural(days, 'day with spend', 'days with spend') : plural(days, 'day of data', 'days of data');
  return `${window.start} to ${window.end} · ${traffic} · ${daysText}`;
}

function FlagRow({ item, profileId, profileLabel, period, noted }: {
  item: FlagContext; profileId: string; profileLabel: string; period: { start: string; end: string }; noted: boolean;
}) {
  const kind = entityKind(item);
  const name = kind === 'campaign' ? item.flag.scope : profileLabel;
  return <li data-tone={noted ? 'neutral' : tone(item.flag.severity)} data-entity={kind}>
    <p className="wa-home-flag-entity">
      <a href={flagEntityHref(item, profileId, period)}>{name}</a>
      <span>{kind === 'campaign' ? 'Campaign' : 'Account'} · {SEVERITY_LABEL[item.flag.severity]}</span>
    </p>
    <p>{item.flag.message}</p>
    <p className="wa-home-flag-evidence">Rule: {item.flag.threshold} · {evidenceLine(item)}</p>
    <p className="wa-home-flag-reason">{noted ? item.flag.suppressedReason ?? 'No suppression reason was recorded.' : item.flag.likelyCause}</p>
  </li>;
}

function IssueGroups({ items, label, profileId, profileLabel, period, noted }: {
  items: FlagContext[]; label: string; profileId: string; profileLabel: string; period: { start: string; end: string }; noted: boolean;
}) {
  const groups = groupFlagsByIssue(items);
  return <div className="wa-home-flag-groups" role="group" aria-label={label}>
    {groups.map((group) => <section key={group.issue} className="wa-home-flag-group" aria-label={`${group.label}${noted ? ' (noted)' : ''}`} data-issue={group.issue}>
      <h4 data-tone={noted ? 'neutral' : tone(group.severity)}>{group.label} <span>({group.items.length})</span></h4>
      <ul aria-label={`${group.label} ${noted ? 'noted' : 'flags'}`}>
        {group.items.map((item, index) => <FlagRow key={`${item.family}-${item.flag.scope}-${index}`} item={item}
          profileId={profileId} profileLabel={profileLabel} period={period} noted={noted} />)}
      </ul>
    </section>)}
  </div>;
}

/**
 * Flags grouped by what is wrong, most severe issue first. Filters narrow
 * both the raised and the noted lists; group headers count the rows shown.
 */
export function FlagsPanel({ flags, profileId, profileLabel, period }: {
  flags: HomeFlags; profileId: string; profileLabel: string; period: { start: string; end: string };
}) {
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [issue, setIssue] = useState<FlagIssue | 'all'>('all');
  const [entity, setEntity] = useState<EntityKind | 'all'>('all');
  const presentIssues = useMemo(() => {
    const present = new Set([...flags.active, ...flags.suppressed].map((item) => flagIssue(item.family).id));
    return FLAG_ISSUES.filter((definition) => present.has(definition.id));
  }, [flags]);
  const keep = (item: FlagContext) => (severity === 'all' || item.flag.severity === severity)
    && (issue === 'all' || flagIssue(item.family).id === issue)
    && (entity === 'all' || entityKind(item) === entity);
  const active = flags.active.filter(keep);
  const suppressed = flags.suppressed.filter(keep);
  const filtered = severity !== 'all' || issue !== 'all' || entity !== 'all';
  return <div className="wa-home-flags">
    <div className="wa-home-flag-filters" role="group" aria-label="Filter flags">
      <label>Severity<select className="wa-input" value={severity} onChange={(event) => setSeverity(event.target.value as Severity | 'all')}>
        <option value="all">All severities</option>
        {SEVERITIES.map((value) => <option key={value} value={value}>{SEVERITY_LABEL[value]}</option>)}
      </select></label>
      <label>Issue<select className="wa-input" value={issue} onChange={(event) => setIssue(event.target.value as FlagIssue | 'all')}>
        <option value="all">All issues</option>
        {presentIssues.map((definition) => <option key={definition.id} value={definition.id}>{definition.label}</option>)}
      </select></label>
      <label>Entity<select className="wa-input" value={entity} onChange={(event) => setEntity(event.target.value as EntityKind | 'all')}>
        <option value="all">All entities</option>
        <option value="campaign">Campaigns</option>
        <option value="account">Account</option>
      </select></label>
    </div>
    <div>
      <h3 data-tone="bad">Raised ({active.length}{filtered ? ` of ${flags.active.length}` : ''})</h3>
      {active.length === 0 ? <p className="wa-home-note">{filtered ? 'No raised flags match these filters.' : 'No active flags.'}</p>
        : <IssueGroups items={active} label="Raised flags" profileId={profileId} profileLabel={profileLabel} period={period} noted={false} />}
    </div>
    <div>
      <h3>Noted, not flagged ({suppressed.length}{filtered ? ` of ${flags.suppressed.length}` : ''})</h3>
      {suppressed.length === 0 ? <p className="wa-home-note">{filtered ? 'No noted findings match these filters.' : 'No suppressed findings.'}</p>
        : <IssueGroups items={suppressed} label="Noted flags" profileId={profileId} profileLabel={profileLabel} period={period} noted />}
    </div>
    {flags.flooredCount > 0 ? <p className="wa-home-caption" data-testid="flags-floored">
      {plural(flags.flooredCount, 'signal', 'signals')} below the evidence floor. Too few impressions or days of data in the window to raise; not counted above.
    </p> : null}
  </div>;
}
