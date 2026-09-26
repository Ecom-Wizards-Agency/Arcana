import type { StreamExtensionEvidence } from '@wizard-ads/shared';

/** Provider observations are read-only evidence and never enter the approval list. */
export function ProviderDiagnostics({ evidence }: { evidence?: StreamExtensionEvidence }) {
  const events = evidence?.events.filter((event) => event.record.datasetId === 'sponsored-ads-campaign-diagnostics-recommendations') ?? [];
  return <section aria-label="Amazon Stream diagnostics"><h2>Amazon Stream diagnostics</h2>
    <p>Source: Amazon Marketing Stream. {evidence?.completeness ?? 'missing'} evidence. These observations carry no approval authority.</p>
    {events.length ? <ul>{events.map((event) => {
      const observation = event.record.observation;
      return 'diagnosticCode' in observation ? <li key={event.identity}>{observation.campaignId}: {observation.diagnosticCode} ({observation.severity}) · <time dateTime={event.record.eventTime}>{event.record.eventTime}</time></li> : null;
    })}</ul> : <p>No campaign diagnostics have been projected.</p>}
    <p>Stream budget advice is unavailable until its provider evidence contract is installed.</p>
  </section>;
}
