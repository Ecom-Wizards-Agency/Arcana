import { period, profile } from '../synthetic-render-fixtures';
import { CreativeLifecycleStatusView, CreativeResultsView } from './evidence-view';
import type { ScreenData } from './view';
const evidence = { producerEligible: false, latestJob: null, snapshot: null };

export const ready = { "view": "ready", "props": { "profile": profile, "period": period, "profileToday": '2026-08-29', "selectedPresetId": undefined, "slot1": <CreativeLifecycleStatusView evidence={evidence} timezone={profile.timezone} profileId={profile.id} />, "slot2": <CreativeResultsView rows={[]} evidence={evidence} currencyCode={profile.currencyCode} profileId={profile.id} /> } } satisfies ScreenData;
