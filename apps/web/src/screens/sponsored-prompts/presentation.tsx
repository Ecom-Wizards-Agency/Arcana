import { formatShellTimestamp } from '../../ui/date-format';
import { dateLabel } from '../creative/format';
import type { CSSProperties, ReactNode } from 'react';
import { analyzeSponsoredPrompts } from '@wizard-ads/core';
import { EXTENSION_REPORT_SUPPORT, sponsoredPromptConsoleUrl, type SponsoredPromptDisplayRow } from '@wizard-ads/shared';
import { DataGrid, tokens } from '@wizard-ads/ui';
import { Button, LinkButton } from '../../ui/primitives';
import type { SponsoredPromptsData } from './load';

const Missing = DataGrid.cells.NotMeasuredCell;
const panel: CSSProperties = { padding: '1.15rem 1.35rem', border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md };
const muted: CSSProperties = { color: tokens.color.textMuted, fontSize: tokens.font.size.sm, lineHeight: 1.6 };
const cell: CSSProperties = { padding: '0.85rem 0.75rem', borderBottom: `1px solid ${tokens.color.border}`, textAlign: 'left', verticalAlign: 'top', whiteSpace: 'nowrap' };
function Metric({ value, currency, percent = false }: { value: number | null; currency?: string; percent?: boolean }) {
  if (value === null) return <Missing reason="The imported intervals do not measure this value" />;
  return <>{percent ? `${(value * 100).toFixed(1)}%` : currency ? new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value) : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value)}</>;
}

export function PromptsPresentation({ data, expanded = false, onToggle, importControl }: {
  data: SponsoredPromptsData; expanded?: boolean; onToggle?: () => void; importControl?: ReactNode;
}) {
  if (data.view === 'gated') return <main aria-label="Sponsored prompts" style={{ maxWidth: 1200 }}><h1>Sponsored prompts</h1><section style={panel}><h2>Sponsored prompts is not available</h2><p>Enable the hosted Sponsored prompts rollout and use an available database with organisation membership.</p><a href="/sync-status">Sync status →</a></section></main>;
  if (data.view === 'empty') return <main aria-label="Sponsored prompts"><h1>Sponsored prompts</h1><h2>No profiles yet</h2><p>Connect a profile before importing prompt observations.</p><a href="/settings/integrations">Manage integrations</a></main>;
  const { snapshot, currencyCode } = data; const analysis = analyzeSponsoredPrompts(snapshot);
  const unchangedSpend = analysis.unchanged.length && analysis.unchanged.every((row) => row.spend !== null) ? analysis.unchanged.reduce((sum, row) => sum + row.spend!, 0) : null;
  return <main aria-label="Sponsored prompts" style={{ maxWidth: 1200, minWidth: 0, margin: '0 auto', color: tokens.color.text, fontFamily: tokens.font.sans }}>
    <h1 style={{ fontSize: tokens.font.size.xl, margin: '0 0 0.5rem' }}>Sponsored prompts</h1>
    <p style={muted}>{snapshot.scheduledImports?.length ? 'Scheduled export and manual imports' : 'Manual import'} · {snapshot.latestObservationAt ? <>last observation <time dateTime={snapshot.latestObservationAt}>{formatShellTimestamp(snapshot.latestObservationAt)}</time></> : 'no observations imported'} · {analysis.live} live, {analysis.paused} paused · <Metric value={analysis.thirtyDays.spend} currency={currencyCode} /> imported spend in the last 30 complete calendar days{analysis.sinceVisit ? <> · <Metric value={analysis.sinceVisit.spend} currency={currencyCode} /> since your last visit</> : ' · first visit; no previous visit marker'} · tables scroll sideways</p>
    <section style={{ ...panel, background: tokens.color.warnSoft, borderColor: tokens.color.warnBorder, margin: '1.5rem 0' }}>
      <h2 style={{ fontSize: tokens.font.size.base, margin: '0 0 0.5rem' }}>There is no bulk pause, and pausing does not hold</h2>
      <p style={{ ...muted, margin: 0 }}>This screen supports manual prompt controls. Pause a prompt in the Ads Console, one ad at a time. A paused prompt can return. This screen shows what changed in your imports and opens the campaign page where you can find the ad.</p>
    </section>
    {snapshot.scheduledImports?.map((r) => <p key={r.referenceId} style={muted}>Scheduled export observed <time dateTime={r.observedAt}>{formatShellTimestamp(r.observedAt)}</time>; collected {formatShellTimestamp(r.collectedAt)}.</p>)}
    <section aria-label="Provider prompt reporting" style={panel}><h2 style={{ fontSize: tokens.font.size.base }}>Provider reports unavailable</h2><p style={muted}>Provider extension IDs must resolve to these prompts before report measurements can be shown. Imported intervals remain separate.</p><ul>{EXTENSION_REPORT_SUPPORT.filter((r) => r.consumer === 'sponsored_prompts').map((r) => <li key={r.reportTypeId}>{r.reportTypeId}: unsupported; disabled</li>)}</ul></section>
    {importControl}
    {snapshot.prompts.length === 0 ? <section style={{ ...panel, borderStyle: 'dashed', margin: '1.5rem 0' }}><h2 style={{ fontSize: tokens.font.size.lg }}>Not measured</h2><p style={muted}>Import an export to see newly sponsored prompts, returns and their cost. No prompt observations have been imported for this profile.</p></section> : <>
      <h2 style={{ margin: '1.5rem 0 0.8rem', fontSize: tokens.font.size.xs }}>WHAT CHANGED{snapshot.lastVisitedAt ? ` SINCE ${dateLabel(snapshot.lastVisitedAt)}` : ' · FIRST VISIT'}</h2>
      {analysis.changed.length ? <PromptTable rows={analysis.changed} countryCode={data.countryCode} currencyCode={currencyCode} /> : <p style={muted}>No newly sponsored or returned prompts since your last visit.</p>}
      {analysis.unchanged.length > 0 ? <section style={{ ...panel, marginTop: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center' }}><div><strong>Unchanged — {analysis.unchanged.filter((row) => row.prompt.currentStatus === 'live').length} live prompts</strong><p style={{ ...muted, margin: '0.35rem 0' }}>First seen before your previous visit, with no recorded return since. {analysis.unchanged.filter((row) => row.prompt.currentStatus === 'paused').length} paused prompts are also unchanged. <Metric value={unchangedSpend} currency={currencyCode} /> spent since first seen.</p></div><Button variant="ghost" size="sm" aria-expanded={expanded} onClick={onToggle}>{expanded ? 'Collapse' : 'Expand'}</Button></div>
        {expanded ? <PromptTable rows={analysis.unchanged} countryCode={data.countryCode} currencyCode={currencyCode} /> : null}
      </section> : null}
      <section style={{ ...panel, margin: '1.5rem 0', background: tokens.color.indigoSoft, borderColor: tokens.color.indigo }}>
        <h2 style={{ fontSize: tokens.font.size.base, margin: '0 0 0.5rem' }}>The cost of the pause loop</h2>
        <p style={{ ...muted, margin: 0 }}>Your imports record {analysis.loop.pausedPrompts} paused prompts. {analysis.loop.returnedPrompts} have returned, with <Metric value={analysis.loop.meanReturnsPerPausedPrompt} /> returns per paused prompt. <Metric value={analysis.thirtyDays.spend} currency={currencyCode} /> over the last 30 complete calendar days against <Metric value={analysis.thirtyDays.sales} currency={currencyCode} /> of attributed sales gives an ACOS of <Metric value={analysis.thirtyDays.acos} percent />. The mean interval between recorded pauses is <Metric value={analysis.loop.meanDaysBetweenPauses} /> days.</p>
        <p style={{ ...muted, marginBottom: 0 }}>Pause and return counts use the full imported history. Consecutive paused observations count as one pause. Intervals crossing a reporting cutoff are not prorated; that window remains not measured.</p>
      </section>
    </>}
    <footer style={{ ...muted, marginTop: '1.5rem' }}><p>Sponsored Products and Sponsored Brands are listed together. Console paths differ by ad type. Links open the campaign’s ad groups; select the ad there to pause its prompt.</p><p>Amounts cover distinct imported intervals. Row totals cover the complete imported history since first seen. A gap between imports leaves prompt status unobserved. Since-visit groups use source observation times; older imports can appear under Unchanged.</p></footer>
  </main>;
}

function PromptTable({ rows, countryCode, currencyCode }: { rows: readonly SponsoredPromptDisplayRow[]; countryCode: string; currencyCode: string }) {
  return <div style={{ overflowX: 'auto', maxWidth: '100%', border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.sm }} tabIndex={0} aria-label="Prompt observations, scroll sideways">
    <table style={{ width: '100%', minWidth: 1180, borderCollapse: 'collapse', fontSize: tokens.font.size.sm }}><thead><tr>{['PROMPT', 'STATUS', 'FIRST SEEN', 'CAMPAIGN', 'AD GROUP', 'SPEND', 'CLICKS', 'SALES', 'ACOS', ''].map((heading, index) => <th key={heading || index} style={{ ...cell, color: tokens.color.textMuted, fontSize: tokens.font.size.eyebrow, background: tokens.color.surfaceAlt }}>{heading || <span aria-label="Console action" />}</th>)}</tr></thead>
      <tbody>{rows.map((row) => {
        const url = sponsoredPromptConsoleUrl(countryCode, row.prompt.adProduct, row.prompt.campaignId);
        const label = row.change === 'newly_sponsored' ? 'newly sponsored' : row.change === 'returned' ? 'returned' : row.prompt.currentStatus;
        return <tr key={row.prompt.id}><td style={{ ...cell, whiteSpace: 'normal', minWidth: 210 }}>{row.prompt.promptText}</td><td style={cell}><span style={{ display: 'inline-block', borderRadius: tokens.radius.sm, padding: '0.2rem 0.45rem', color: row.change === 'newly_sponsored' ? tokens.color.bad : row.change === 'returned' ? tokens.color.warn : tokens.color.textMuted, background: row.change === 'newly_sponsored' ? tokens.color.badSoft : row.change === 'returned' ? tokens.color.warnSoft : tokens.color.surfaceAlt }}>{label}</span>{row.change !== 'unchanged' && row.prompt.currentStatus === 'paused' ? <small style={{ display: 'block', color: tokens.color.textMuted }}>currently paused</small> : null}</td>
          <td style={cell}>{row.change === 'returned' && row.returnedAt ? `back ${dateLabel(row.returnedAt)}` : dateLabel(row.prompt.firstSeenAt)}</td><td style={cell}>{row.prompt.campaignName ?? row.prompt.campaignId}<small style={{ display: 'block', color: tokens.color.textMuted }}>{row.prompt.adProduct}</small></td><td style={cell}>{row.prompt.adGroupName ?? row.prompt.adGroupId}</td>
          <td style={cell}><Metric value={row.spend} currency={currencyCode} /></td><td style={cell}><Metric value={row.clicks} /></td><td style={cell}><Metric value={row.sales} currency={currencyCode} /></td><td style={cell}><Metric value={row.acos} percent /></td>
          <td style={cell}>{url ? <LinkButton variant="ghost" size="sm" href={url} rel="noopener noreferrer" target="_blank">Pause in console ↗</LinkButton> : <Button disabled title="Console destination unavailable for this marketplace">Pause in console ↗</Button>}</td></tr>;
      })}</tbody>
    </table>
  </div>;
}
