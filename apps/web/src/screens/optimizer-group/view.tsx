import { gateMessage } from '../../ui/gate-message';
import { PageHeader } from '../../ui/primitives';
import { GroupPerformance } from './performance';
import type { load } from './load';
import styles from '../methods/styles.module.css';
export type ScreenData = Awaited<ReturnType<typeof load>>;
export default function Screen({ data }: { data: ScreenData }) {
  return <main className={styles.page}><PageHeader title={data.view === 'ready' ? data.props.record.group.name : 'Optimization group'} subtitle="Performance / Current members" />
    {data.view === 'gated' ? <p>{gateMessage(data.props.entry.state)}</p> : data.view === 'empty' ? <p>No profiles yet.</p> : data.view === 'missing' ? <p>Group unavailable for this profile.</p> : <>
      <div className={styles.actions}><span className={`${styles.action} ${styles.primary}`}>Performance</span><a className={styles.action} href={`/optimizer/groups/${data.props.record.group.id}/settings?profile=${data.props.profile.id}`}>Settings</a><a className={styles.action} href={`/optimizer/groups?profile=${data.props.profile.id}`}>Back to groups</a></div>
      <GroupPerformance performance={data.props.performance} currency={data.props.profile.currencyCode} profileId={data.props.profile.id} />
    </>}
  </main>;
}
