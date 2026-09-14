import { BidHistoryContent } from '../../ui/bid-history-modal';
import { gateMessage } from '../../ui/gate-message';
import type { load } from './load';
export default function ScreenView({ data }: { data: Awaited<ReturnType<typeof load>> }) {
  if (data.view === 'gated') return <main><h1>Target history</h1><p>{gateMessage(data.state)}</p></main>;
  return <main>
    <a href={data.back}>Back to grid</a>
    <h1>{data.payload.target.targeting}</h1>
    <p>{data.payload.target.campaignName} · {data.payload.window.from} to {data.payload.window.to}</p>
    <BidHistoryContent payload={data.payload} currencyCode={data.currencyCode} />
    <section aria-label="Rank observations">
      <h2>Rank observations</h2>
      {data.ranks.length === 0 ? <p>No rank observations measured for this keyword and profile in this period.</p> :
        <table><thead><tr><th>Date</th><th>ASIN</th><th>Organic rank</th><th>Sponsored rank</th></tr></thead>
          <tbody>{data.ranks.map((row, index) => <tr key={index}><td>{row.date}</td><td>{row.asin}</td><td>{row.organicRank ?? 'Not measured'}</td><td>{row.sponsoredRank ?? 'Not measured'}</td></tr>)}</tbody>
        </table>}
    </section>
  </main>;
}
