import { Card, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';

export default function QueryIntelligenceLoading() {
  return <main style={page} aria-busy="true"><PageHeader title="Search query performance (SQP)" subtitle="Loading weekly SQP and PPC attribution evidence…" /><Card><p className="wa-page-sub">Reading intent, share, vocabulary, and review/export rows.</p></Card></main>;
}
