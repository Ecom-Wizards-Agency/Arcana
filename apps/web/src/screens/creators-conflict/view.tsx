import type { CreatorConflictDetail, CreatorFingerprintClass, CreatorRecord } from '@wizard-ads/shared';
import { Badge, Button, EmptyState, TableFrame } from '../../ui/primitives';
import { formatShellDate, formatTimestamp } from '../../ui/date-format';
import {
  ACTION_WORDS, CreatorGated, CreatorHeader, CreatorLoadError, FINGERPRINT_CLASS_LABEL, ImportRefusal, LockBadge, SectionHead, SOURCE_LABEL,
  count, lastRead,
} from '../creators-daily-queue/creator-frame';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

const TITLE = 'Creator record conflict';
export const CONFLICT_REASON = 'Locked in Conflict: nothing here may act until the identity is resolved in the registry.';
/** The actions a record can otherwise take in Arcana or by hand; here every one is disabled. */
export const LOCKED_ACTIONS = ['Approve a reply draft', 'Write the computed score to the tracker', 'Move the tracker status', 'Start the sample pre-flight'] as const;
const CLASSES = ['storefront', 'thread', 'fullName', 'email', 'phone', 'address'] as const satisfies readonly CreatorFingerprintClass[];

function RecordCard({ record, shared, named, self }: { record: CreatorRecord; shared: readonly CreatorFingerprintClass[]; named: boolean; self: boolean }) {
  const present = CLASSES.filter((key) => record.fingerprints[key] !== null);
  return <div className="wa-card" data-testid="conflict-record" data-record={record.creatorRecordId} data-self={self ? 'true' : 'false'}>
    <div className="wa-card__body wa-stack" style={{ gap: '0.5rem' }}>
      <h2 className="wa-card__title"><a href={`/creators/records/${record.creatorRecordId}`}>{record.creatorRecordId}</a> <LockBadge lock={record.lockState} />
        {record.lockState === 'Unlocked' ? <Badge tone="neutral">Unlocked</Badge> : null}</h2>
      <p className="wa-page-sub">{self ? 'This record' : named ? 'Named by the resolution that locked it' : 'Matches by fingerprint'}</p>
      <p>Status: {record.status ?? <span className="wa-page-sub">not reported</span>}<br />
        <span className="wa-page-sub">Record {record.recordState} · campaign {record.campaignId} · created {formatShellDate(record.createdOn)}</span></p>
      <p data-testid="fingerprint-classes">Fingerprints held:{' '}
        {present.length === 0 ? <span className="wa-page-sub">none recorded</span>
          : present.map((key, index) => <span key={key}>{index ? ', ' : ''}{shared.includes(key)
            ? <strong data-shared={key}>{FINGERPRINT_CLASS_LABEL[key]} (shared)</strong> : FINGERPRINT_CLASS_LABEL[key]}</span>)}</p>
      {!self && shared.length === 0 ? <p className="wa-page-sub" data-testid="shared-none">Shares no fingerprint class with this record: only the resolution named it.</p> : null}
    </div>
  </div>;
}

function ReadyConflict({ detail }: { detail: CreatorConflictDetail }) {
  const { record, counterparts, events, lastImport, lockedSince } = detail;
  const id = record.creatorRecordId;
  if (record.lockState !== 'Conflict') {
    return <main className="wa-stack" data-testid="creator-conflict"><CreatorHeader title={TITLE} subtitle={<>{id} · {lastRead(lastImport)}</>} />
      <EmptyState variant="empty" data-creator-state="not-in-conflict" title="This record is not in Conflict"
        body={<>{id} is {record.lockState === 'Unlocked' ? 'unlocked' : `locked for another reason (${record.lockState})`}, so there is no conflict to show.</>}
        action={<a href={`/creators/records/${id}`} data-testid="record-link">Open the record</a>} /></main>;
  }
  const sharedAll = [...new Set(counterparts.flatMap((counterpart) => counterpart.shared))];
  return <main className="wa-stack" data-testid="creator-conflict" data-record={id}>
    <CreatorHeader title={TITLE} subtitle={<>{id} and {count(counterparts.length)} {counterparts.length === 1 ? 'other record' : 'other records'} · {lastRead(lastImport)}</>}>
      <span data-testid="locked-since">{lockedSince === null
        ? <>Locked since: <span className="wa-page-sub" data-creator-state="locked-since-not-recorded">not recorded, the runner kept no date</span></>
        : <>Locked since {formatShellDate(lockedSince)}</>}</span>
    </CreatorHeader>
    <p className="wa-page-sub"><a href={`/creators/records/${id}`}>Back to {id}</a> · <a href="/creators">Creator queue</a></p>
    {lastImport?.status === 'failed' ? <ImportRefusal run={lastImport} withheld="The records below are as last read; nothing here may act either way." /> : null}
    <p className="wa-banner wa-banner--bad" id="conflict-reason" data-testid="conflict-reason" style={{ display: 'block' }}><strong>{CONFLICT_REASON}</strong>
      {' '}Two records resolve to one creator{sharedAll.length ? <> through a shared {sharedAll.map((key) => FINGERPRINT_CLASS_LABEL[key]).join(', ')} fingerprint</> : null}.
      {' '}The runner resolves it; Arcana shows it.</p>
    <section aria-label="The records side by side" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(18rem, 1fr))', gap: '1rem' }}>
      <RecordCard record={record} shared={sharedAll} named={false} self />
      {counterparts.map((counterpart) => <RecordCard key={counterpart.record.creatorRecordId} record={counterpart.record} shared={counterpart.shared}
        named={counterpart.namedByResolution} self={false} />)}
    </section>
    {counterparts.length === 0 ? <p className="wa-page-sub" data-testid="no-counterparts">No other active record is registered with a matching fingerprint, and the resolution named none; the lock stays until the registry releases it.</p> : null}
    <section aria-label="Actions" className="wa-stack" data-testid="locked-actions">
      <SectionHead title="Actions" />
      <div className="wa-row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        {LOCKED_ACTIONS.map((action) => <Button key={action} disabled aria-describedby="conflict-reason" title={CONFLICT_REASON} data-locked-action={action}>{action}</Button>)}
      </div>
      <p className="wa-page-sub" data-testid="disabled-reason">{CONFLICT_REASON}</p>
    </section>
    <section aria-label="Identity events" className="wa-stack" data-testid="conflict-events">
      <SectionHead title="Identity events">{count(events.length)}</SectionHead>
      {events.length === 0
        ? <p className="wa-page-sub" data-testid="no-identity-events">The action log holds no identity event for these records.</p>
        : <TableFrame><table className="wa-table"><thead><tr><th>When</th><th>Record</th><th>What</th><th>With</th><th>Evidence</th><th>Source</th></tr></thead>
          <tbody>{events.map((event) => <tr key={`${event.creatorRecordId}:${event.eventKey}`} data-testid="identity-event" data-action={event.action}>
            <td>{event.occurredAt === null ? <span className="wa-page-sub" data-time="not-recorded">time not recorded</span> : formatTimestamp(event.occurredAt)}</td>
            <td>{event.creatorRecordId}</td><td>{ACTION_WORDS[event.action]}{event.action === 'identity_resolved' && event.reasonCode ? ` (${event.reasonCode})` : ''}</td>
            <td>{event.relatedRecordIds.length ? event.relatedRecordIds.map((related, index) => <span key={related}>{index ? ', ' : ''}<a href={`/creators/records/${related}`}>{related}</a></span>)
              : <span className="wa-page-sub">none named</span>}</td>
            <td>{event.evidenceReference ?? <span className="wa-page-sub">none</span>}</td><td>{SOURCE_LABEL[event.source]}</td>
          </tr>)}</tbody></table></TableFrame>}
    </section>
  </main>;
}

export default function Screen({ data }: { data: ScreenData }) {
  switch (data.view) {
    case 'ready': return <ReadyConflict detail={data.props.detail} />;
    case 'missing': return <main className="wa-stack" data-testid="creator-conflict"><CreatorHeader title={TITLE} subtitle="Creator Connections" />
      <EmptyState variant="empty" data-creator-state="record-missing" title="No such record"
        body={data.props.id === null ? 'This address does not name a creator record id.' : `No creator record ${data.props.id} is registered for this organisation.`}
        action={<a href="/creators">Creator queue</a>} /></main>;
    case 'gated': return <main className="wa-stack"><CreatorHeader title={TITLE} subtitle="Creator Connections" /><CreatorGated /></main>;
    case 'error': return <CreatorLoadError title={TITLE} message={data.props.message} />;
  }
}
