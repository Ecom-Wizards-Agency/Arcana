import { expect, it } from 'vitest';
import { EXTENSION_REPORT_SUPPORT } from './extension-report-support.js';

it('keeps all three named extension slices explicitly unsupported and disabled', () => {
  expect(EXTENSION_REPORT_SUPPORT.map((s) => s.reportTypeId)).toEqual([
    'spPromptAdExtension', 'sbPromptAdExtension', 'spVideoAdExtension',
  ]);
  for (const slice of EXTENSION_REPORT_SUPPORT) {
    expect(slice).toMatchObject({ state: 'unsupported', enabled: false,
      maxRangeDays: 90, retentionDays: 95, formats: ['JSON', 'XLSX'] });
    expect(slice.reason).toContain('identity_and_report_family_seam_missing');
  }
});
