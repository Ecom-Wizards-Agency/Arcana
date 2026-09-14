import { money } from '../optimizer-review/presentation';
import { can } from '../../auth/roles';
import { gateMessage } from '../../ui/gate-message';
import { PageHeader } from '../../ui/primitives';
import { OptimizationGroupsManager } from '../optimizer-groups/groups-manager';
import { GroupMembers } from './members';
import type { load } from './load';
import styles from '../methods/styles.module.css';
export type ScreenData = Awaited<ReturnType<typeof load>>;
export default function Screen({ data }: { data: ScreenData }) {
  return <main className={styles.page} data-testid={data.view === 'ready' ? 'optimizer-group-settings-ready' : undefined}><PageHeader title={data.view === 'ready' ? `${data.props.record.group.name} settings` : 'Group settings'} subtitle="Saved settings apply to every campaign in this group" />
    {data.view === 'gated' ? <p>{gateMessage(data.props.entry.state)}</p> : data.view === 'empty' ? <p>No profiles yet.</p> : data.view === 'missing' ? <p>Group unavailable for this profile.</p> : (() => {
      const { group } = data.props.record;
      const { profile, workspace } = data.props;
      const rows = [['Group', group.name], ['Target ACOS', group.targetAcos > 0 ? `${group.targetAcos * 100}%` : 'Missing required value'], ['Bid floor / ceiling', `${money(group.bidFloor, profile.currencyCode, 'Not set')} / ${money(group.bidCeiling, profile.currencyCode, 'Not set')}`], ['Maximum increase / decrease', `+${group.bidIncreaseCap * 100}% / −${group.bidDecreaseCap * 100}% per cycle`], ['Review schedule', `${group.reviewSchedule.weekdays.join(', ')} · ${String(workspace.reviewHour).padStart(2, '0')}:00 · ${workspace.profileTimezone}`]];
      return <><table className={styles.table}><thead><tr><th>Setting</th><th>Value</th></tr></thead><tbody>{rows.map(([name, value]) => <tr key={name}><td>{name}</td><td>{value}</td></tr>)}<tr><td>Members</td><td>{data.props.record.campaignIds.length} campaigns <GroupMembers profileId={profile.id} groupId={group.id} initial={workspace} /></td></tr></tbody></table>
        <p>A scheduled review prepares suggestions. Enabling an automatic execution cadence requires its own limits and operator approval.</p>
        <div className={styles.actions}><a className={styles.action} href={`/optimizer/groups/${group.id}/settings?profile=${profile.id}&edit=1`}>Edit group settings</a><a className={styles.action} href={`/optimizer/groups/${group.id}?profile=${profile.id}`}>View performance</a><a className={styles.action} href={`/optimizer/groups?profile=${profile.id}`}>Back to groups</a></div>
        {data.props.editing ? <><section className={styles.panel}><h2>Review weekdays</h2><p>A scheduled run prepares a preview. It never sends anything.</p><ol><li>Choose the campaigns in this group.</li><li>Set the target and change limits.</li><li>Select review weekdays.</li><li>Review the profile's local time and timezone.</li><li>Save group settings, then review each prepared preview.</li></ol></section>
          <OptimizationGroupsManager profileId={profile.id} initial={{ ...workspace, groups: [data.props.record, ...workspace.groups.filter((entry) => entry.group.id !== group.id)] }} canManage={can(data.props.context.active?.role, 'editTargets')} previewReady={data.props.previewReadiness.ready} /></> : null}
      </>;
    })()}
  </main>;
}
