import {
  HOSTED_MIGRATION_BUNDLE_POLICY,
  type HostedMigrationBundlePolicy,
} from './policy.js';

function migrationPath(filename: string): string {
  return ['supabase', 'migrations', filename].join('/');
}

/**
 * The second manual window starts only after the five-file WP-207 window.
 * These reviewed pins deliberately do not follow files read from the working tree.
 * Changing any migration requires a new reviewed policy and rehearsal.
 */
export const WRITE_WINDOW_BUNDLE_POLICY: HostedMigrationBundlePolicy = Object.freeze({
  baseline: Object.freeze([
    ...HOSTED_MIGRATION_BUNDLE_POLICY.baseline,
    ...HOSTED_MIGRATION_BUNDLE_POLICY.additions.map(({ filename, byteCount, sha256 }) =>
      Object.freeze({ filename, byteCount, sha256 }),
    ),
  ]),
  additions: Object.freeze([
    { workPackage: 'WP-214', repositoryPath: migrationPath('20260905000000_sp_write_preview_evidence.sql'), filename: '20260905000000_sp_write_preview_evidence.sql', byteCount: 14609, sha256: '3d665ddd1619a0ace66b76a8639b9a637be36a25844da391f15fa441110726bf' },
    { workPackage: 'WP-214', repositoryPath: migrationPath('20260905010000_sp_write_preview_approval.sql'), filename: '20260905010000_sp_write_preview_approval.sql', byteCount: 6135, sha256: 'fb5478d1ce6234f9983e64e33d4cedbb6b4f96a8e7e46746f346bf86215ff616' },
    { workPackage: 'WP-214', repositoryPath: migrationPath('20260905020000_sp_write_application_entry.sql'), filename: '20260905020000_sp_write_application_entry.sql', byteCount: 731, sha256: 'd927eaca878608bb3be39a3865b53840f416e901c9b126e7d7265e4689d086a0' },
    { workPackage: 'WP-214', repositoryPath: migrationPath('20260905030000_sp_write_mirror_observations.sql'), filename: '20260905030000_sp_write_mirror_observations.sql', byteCount: 14926, sha256: 'e29ecf16437a289173998b06add8e6e2a990774867ce9e0d7f33fc6e2f416d56' },
    { workPackage: 'WP-214', repositoryPath: migrationPath('20260905040000_recommendation_proposal_revisions.sql'), filename: '20260905040000_recommendation_proposal_revisions.sql', byteCount: 31561, sha256: '1944e3b2f9c71dedd0b5b2a38d8cee12b116cdf309e3455e46155921ca82ba1c' },
    { workPackage: 'WP-217', repositoryPath: migrationPath('20260906000000_mcp_write_delegation_mode.sql'), filename: '20260906000000_mcp_write_delegation_mode.sql', byteCount: 349, sha256: '23b98a1400dfb55db2554614057b0a80c8255e684b723928b9ab704d7b8fa396' },
    { workPackage: 'WP-217', repositoryPath: migrationPath('20260906010000_mcp_write_delegations.sql'), filename: '20260906010000_mcp_write_delegations.sql', byteCount: 15934, sha256: '153b98274e3c276f5962fc5ea525464af2ee9442c85a0fa5c967b4d93dd09e55' },
    { workPackage: 'WP-217', repositoryPath: migrationPath('20260906020000_mcp_bid_proposal_sources.sql'), filename: '20260906020000_mcp_bid_proposal_sources.sql', byteCount: 71917, sha256: 'd9ac97df1b4e37e2e06922db30e49b9782f2200a72878d314dd4cd57a6e1d4ce' },
    { workPackage: 'WP-217', repositoryPath: migrationPath('20260906030000_mcp_write_admissions.sql'), filename: '20260906030000_mcp_write_admissions.sql', byteCount: 79533, sha256: '0b412a73312b55ad54c2fd39025a1b99c2368d193856972b46a84cdea34f526d' },
    { workPackage: 'WP-217', repositoryPath: migrationPath('20260906040000_mcp_write_preview_sources.sql'), filename: '20260906040000_mcp_write_preview_sources.sql', byteCount: 12877, sha256: '8d1fb424efd4d096e05d01fe66c085658fc3cc6476646e78d917f7eebc3bac72' },
  ]),
  baselineByteCount: 646628,
  baselineLastVersion: '20260901060000',
  baselineLedgerSha256: 'baef4df400ed7a045395322667e1d3ac61fa27075b2d36bb855071a6bfe20458',
  bundleByteCount: 895200,
  bundleLastVersion: '20260906040000',
  bundleLedgerSha256: '491acc42c424a74beb33ce6af874cdf3bd90ecec9aa430f49887fc6b6efb0956',
});
