'use client';
import { useState } from 'react';
import type { OptimizationWorkspace } from '@wizard-ads/db';
import { Info } from '../methods/info';
import styles from '../methods/styles.module.css';
export function GroupMembers({ profileId, groupId, initial }: { profileId: string; groupId: string; initial?: OptimizationWorkspace }) {
  const [workspace, setWorkspace] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function refresh() {
    setPending(true); setError(null);
    try {
      const response = await fetch(`/api/optimizer/groups?profileId=${encodeURIComponent(profileId)}`);
      if (!response.ok) throw new Error('Members could not be loaded.');
      setWorkspace(await response.json() as OptimizationWorkspace);
    } catch { setError('Members could not be loaded. Try again.'); }
    finally { setPending(false); }
  }
  const members = workspace?.campaigns.filter((campaign) => campaign.groupId === groupId);
  return <Info label="Group members">{error ? <p role="alert">{error}</p> : members === undefined ? <p>Members have not been loaded.</p> : <><strong>{members.length} current campaigns</strong><ul>{members.map((campaign) => <li key={campaign.campaignId}>{campaign.name}</li>)}</ul></>}
    <button type="button" className={styles.action} disabled={pending} onClick={() => { void refresh(); }}>{pending ? 'Loading members…' : 'Reload members'}</button></Info>;
}
