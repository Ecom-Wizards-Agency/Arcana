import type { BuildBundleOptions, VerifyBundleOptions } from './bundle.js';
import {
  buildWithPolicy,
  type BundleEvidence as EngineBundleEvidence,
  verifyWithPolicy,
} from './engine.js';
import { WRITE_WINDOW_BUNDLE_POLICY } from './write-window-policy.js';

export interface WriteWindowBundleEvidence {
  readonly status: 'verified';
  readonly artifactMode: 'sealed' | 'cli_workdir';
  readonly sourceRevision: string;
  readonly baselineFiles: 46;
  readonly addedFiles: 10;
  readonly totalFiles: 56;
  readonly totalBytes: 895200;
  readonly lastVersion: '20260906040000';
  readonly baselineLedgerSha256: string;
  readonly bundleLedgerSha256: string;
  readonly manifestSha256: string;
}

export async function buildWriteWindowBundle(
  options: BuildBundleOptions,
): Promise<WriteWindowBundleEvidence> {
  const evidence = await buildWithPolicy({
    ...options,
    repoWorkdir: process.cwd(),
    policy: WRITE_WINDOW_BUNDLE_POLICY,
  });
  return publicEvidence(evidence);
}

export async function verifyWriteWindowBundle(
  options: VerifyBundleOptions,
): Promise<WriteWindowBundleEvidence> {
  const evidence = await verifyWithPolicy({
    ...options,
    repoWorkdir: process.cwd(),
    policy: WRITE_WINDOW_BUNDLE_POLICY,
  });
  return publicEvidence(evidence);
}

function publicEvidence(evidence: EngineBundleEvidence): WriteWindowBundleEvidence {
  if (
    evidence.baselineFiles !== 46 ||
    evidence.addedFiles !== 10 ||
    evidence.totalFiles !== 56 ||
    evidence.totalBytes !== 895200 ||
    evidence.lastVersion !== '20260906040000'
  ) {
    throw new Error('fixed write-window migration policy invariant failed');
  }
  return {
    ...evidence,
    baselineFiles: 46,
    addedFiles: 10,
    totalFiles: 56,
    totalBytes: 895200,
    lastVersion: '20260906040000',
  };
}
