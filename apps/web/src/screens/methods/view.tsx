import type { OptimizationGroupRecord } from '@wizard-ads/db';
import type { OptimizationGroupRole } from '@wizard-ads/shared';
import { gateMessage } from '../../ui/gate-message';
import { PageHeader } from '../../ui/primitives';
import { CatalogueTable, MethodIdentifiers } from './picker';
import type { load } from './load';
import styles from './styles.module.css';
export type ScreenData = Awaited<ReturnType<typeof load>>;
const GOALS: Record<OptimizationGroupRole, { mapping: string; need: string; status: string }> = {
  profit: { mapping: 'Efficient revenue · generic category · maintenance', need: 'Target efficiency. Contribution profit requires verified margins.', status: 'Mapped' },
  rank: { mapping: 'Organic growth · generic category · validation', need: 'Requires a query or ASIN, hypothesis, cost bound and evaluation period.', status: 'Needs a test plan' },
  shield: { mapping: 'Efficient revenue · own brand · maintenance', need: 'Efficiency, or a defence experiment that measures substitution.', status: 'Mapped' },
  discovery: { mapping: 'Selected objective · generic category · exploration', need: 'Requires a learning budget and graduation rule.', status: 'Needs a budget' },
};
export function CampaignGoals({ groups }: { groups: readonly OptimizationGroupRecord[] }) {
  return <section id="goals"><h2>Campaign goals</h2><p>Business objective, targeting intent and lifecycle are separate decisions. These proposed mappings come from the saved group role.</p>
    <div className={styles.columns}>{[['Business objective', 'Efficient revenue · Contribution profit · Organic growth · Customer acquisition'], ['Targeting intent', 'Own brand · Generic category · Competitor · Mixed or unknown'], ['Lifecycle', 'Exploration · Validation · Scaling · Maintenance']].map(([title, body]) => <div className={styles.panel} key={title}><strong>{title}</strong><p>{body}</p></div>)}</div>
    <table className={styles.table}><thead><tr><th>Existing preset</th><th>Proposed mapping</th><th>Method and review need</th><th>Status / Groups</th></tr></thead><tbody>{(Object.keys(GOALS) as OptimizationGroupRole[]).map((role) => <tr key={role}><td>{role[0]!.toUpperCase() + role.slice(1)}</td><td>{GOALS[role].mapping}</td><td>{GOALS[role].need}</td><td>{GOALS[role].status} · {groups.filter((entry) => entry.group.role === role).length}</td></tr>)}</tbody></table>
    <p className={styles.muted}>Mappings are read-only. A Profit group means efficiency by default; its name does not establish contribution-profit economics. Learning needs its own budget and deadline.</p></section>;
}
export default function Screen({ data }: { data: ScreenData }) {
  return <main className={styles.page}><PageHeader title="Optimization methods" subtitle="Choose a method compatible with the campaign" />
    {data.view === 'gated' ? <p>{gateMessage(data.props.entry.state)}</p> : data.view === 'empty' ? <p>No profiles yet.</p> : <>
      <CatalogueTable /><div className={styles.actions}><a className={styles.action} href="#identifiers">Method identifiers and formulas</a><a className={styles.action} href={`/optimizer/settings?profile=${data.props.profileId}`}>Back to settings</a></div>
      <MethodIdentifiers /><CampaignGoals groups={data.props.groups} /></>}
  </main>;
}
