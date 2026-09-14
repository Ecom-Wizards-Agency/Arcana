// Generated imports: run src/screens/generate-registry.ts after adding a descriptor.
import type { ScreenMetadata } from './types';
import { descriptor as brand_lens } from './brand-lens/descriptor';
import { descriptor as bugs } from './bugs/descriptor';
import { descriptor as campaigns } from './campaigns/descriptor';
import { descriptor as cockpit } from './cockpit/descriptor';
import { descriptor as connect_claude } from './connect-claude/descriptor';
import { descriptor as creative } from './creative/descriptor';
import { descriptor as creators_daily_queue } from './creators-daily-queue/descriptor';
import { descriptor as creators_inbox_sweep } from './creators-inbox-sweep/descriptor';
import { descriptor as creators_sample_shipments } from './creators-sample-shipments/descriptor';
import { descriptor as crosscheck } from './crosscheck/descriptor';
import { descriptor as dashboard } from './dashboard/descriptor';
import { descriptor as dayparting } from './dayparting/descriptor';
import { descriptor as experiments } from './experiments/descriptor';
import { descriptor as experiments_detail } from './experiments-detail/descriptor';
import { descriptor as experiments_new } from './experiments-new/descriptor';
import { descriptor as feedback } from './feedback/descriptor';
import { descriptor as feedback_new } from './feedback-new/descriptor';
import { descriptor as grid } from './grid/descriptor';
import { descriptor as grid_ad_groups } from './grid-ad-groups/descriptor';
import { descriptor as grid_campaigns } from './grid-campaigns/descriptor';
import { descriptor as grid_placements } from './grid-placements/descriptor';
import { descriptor as grid_products } from './grid-products/descriptor';
import { descriptor as grid_search_terms } from './grid-search-terms/descriptor';
import { descriptor as grid_targets } from './grid-targets/descriptor';
import { descriptor as market_position } from './market-position/descriptor';
import { descriptor as ngrams } from './ngrams/descriptor';
import { descriptor as optimizer } from './optimizer/descriptor';
import { descriptor as optimizer_groups } from './optimizer-groups/descriptor';
import { descriptor as queries } from './queries/descriptor';
import { descriptor as query_intelligence } from './query-intelligence/descriptor';
import { descriptor as recommendations } from './recommendations/descriptor';
import { descriptor as roadmap } from './roadmap/descriptor';
import { descriptor as settings } from './settings/descriptor';
import { descriptor as settings_account } from './settings-account/descriptor';
import { descriptor as settings_connections } from './settings-connections/descriptor';
import { descriptor as settings_integrations } from './settings-integrations/descriptor';
import { descriptor as settings_members } from './settings-members/descriptor';
import { descriptor as settings_profiles } from './settings-profiles/descriptor';
import { descriptor as sponsored_prompts } from './sponsored-prompts/descriptor';
import { descriptor as strategy } from './strategy/descriptor';
import { descriptor as sync_status } from './sync-status/descriptor';
import { descriptor as tags } from './tags/descriptor';
import { descriptor as targets } from './targets/descriptor';
import { descriptor as targets_queue } from './targets/queue/descriptor';
import { descriptor as time_machine } from './time-machine/descriptor';
import { descriptor as time_machine_legacy } from './time-machine/legacy/descriptor';
import { descriptor as timeline } from './timeline/descriptor';
import { descriptor as translation_status } from './translation-status/descriptor';

/** The single inventory of physical pages, query presets and disabled planned screens. */
export const SCREEN_REGISTRY: readonly ScreenMetadata[] = [
  brand_lens,
  bugs,
  campaigns,
  cockpit,
  connect_claude,
  creative,
  creators_daily_queue,
  creators_inbox_sweep,
  creators_sample_shipments,
  crosscheck,
  dashboard,
  dayparting,
  experiments,
  experiments_detail,
  experiments_new,
  feedback,
  feedback_new,
  grid,
  grid_ad_groups,
  grid_campaigns,
  grid_placements,
  grid_products,
  grid_search_terms,
  grid_targets,
  market_position,
  ngrams,
  optimizer,
  optimizer_groups,
  queries,
  query_intelligence,
  recommendations,
  roadmap,
  settings,
  settings_account,
  settings_connections,
  settings_integrations,
  settings_members,
  settings_profiles,
  sponsored_prompts,
  strategy,
  sync_status,
  tags,
  targets,
  targets_queue,
  time_machine,
  time_machine_legacy,
  timeline,
  translation_status,
];

export { SCREEN_GROUPS } from './groups';
