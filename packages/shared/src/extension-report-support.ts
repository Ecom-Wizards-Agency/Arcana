/** Prerequisite evidence is absent on this integration base; these are not worker report IDs. */
export const EXTENSION_REPORT_SUPPORT = [
  { reportTypeId: 'spPromptAdExtension', grain: 'promptAdExtension', consumer: 'sponsored_prompts',
    state: 'unsupported', reason: 'provider_prompt_identity_and_report_family_seam_missing',
    maxRangeDays: 90, retentionDays: 95, formats: ['JSON', 'XLSX'], enabled: false },
  { reportTypeId: 'sbPromptAdExtension', grain: 'promptAdExtension', consumer: 'sponsored_prompts',
    state: 'unsupported', reason: 'provider_prompt_identity_and_report_family_seam_missing',
    maxRangeDays: 90, retentionDays: 95, formats: ['JSON', 'XLSX'], enabled: false },
  { reportTypeId: 'spVideoAdExtension', grain: 'videoAdExtension', consumer: 'creatives',
    state: 'unsupported', reason: 'provider_asset_identity_and_report_family_seam_missing',
    maxRangeDays: 90, retentionDays: 95, formats: ['JSON', 'XLSX'], enabled: false },
] as const;
export type ExtensionReportSupport = typeof EXTENSION_REPORT_SUPPORT[number];
