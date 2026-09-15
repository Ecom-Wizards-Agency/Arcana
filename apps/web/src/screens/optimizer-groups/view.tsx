import { money } from '../optimizer-review/presentation';
import { gateMessage } from '../../ui/gate-message';
import { EmptyState, PageHeader } from '../../ui/primitives';
import type { load } from './load';
import styles from '../methods/styles.module.css';
export type ScreenData = Awaited<ReturnType<typeof load>>;
export default function Screen({ data }: { data: ScreenData }) {
  const description = 'Campaigns with shared targets, limits and review schedules';
  return <main className={styles.page}><PageHeader title="Optimization Groups" subtitle={data.view === 'ready' ? `${data.props.profile.label} · ${description}` : description} />
    {data.view === 'gated' ? <p>{gateMessage(data.props.entry.state)}</p> : data.view === 'empty' ? <EmptyState title="No profiles yet" body="Connect Amazon Ads before assigning campaigns to optimization groups." /> : <>
      <table className={styles.table}><thead><tr><th>Group</th><th>Target ACOS</th><th>Limits</th><th>Campaigns</th><th>Open</th></tr></thead><tbody>
        {data.props.workspace.groups.map(({ group, campaignIds }) => <tr key={group.id}><td>{group.name}</td><td>{group.targetAcos > 0 ? `${group.targetAcos * 100}%` : 'Missing required target'}</td>
          <td>{group.bidFloor === null && group.bidCeiling === null ? 'Not set' : `${money(group.bidFloor, data.props.profile.currencyCode, 'Not set')} to ${money(group.bidCeiling, data.props.profile.currencyCode, 'Not set')}`}<br />+{group.bidIncreaseCap * 100}% / −{group.bidDecreaseCap * 100}% per cycle</td><td>{campaignIds.length}</td>
          <td><div className={styles.actions}><a href={`/optimizer/groups/${group.id}?profile=${data.props.profile.id}`}>Open group</a><a href={`/optimizer/groups/${group.id}/settings?profile=${data.props.profile.id}`}>View settings</a></div></td></tr>)}
      </tbody></table>{data.props.workspace.groups.length === 0 ? <p>No optimization groups yet.</p> : null}
      <div className={styles.actions}><a className={styles.action} href={`/optimizer?profile=${data.props.profile.id}`}>Back to campaigns</a></div>
    </>}
  </main>;
}
