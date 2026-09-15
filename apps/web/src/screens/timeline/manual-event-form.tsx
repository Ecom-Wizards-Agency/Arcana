'use client';
import { useState } from 'react';
import { TimelineEvent, TimelineEventInput, TimelineManualKind } from '@wizard-ads/shared';
import { Button } from '../../ui/primitives';
export function ManualEventForm({ profileId, event, start, onClose, onSaved }: {
    profileId: string;
    event: TimelineEvent | null;
    start: string;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [message, setMessage] = useState(''), [pending, setPending] = useState(false);
    return <section className="tl-dialog" role="dialog" aria-label={event ? 'Supersede event' : 'Record event'}><h2>{event ? 'Supersede event' : 'Record event'}</h2><p>Edits create a new revision. Earlier observations stay in the history.</p><form onSubmit={(e) => { e.preventDefault(); if (pending)
        return; const fields = new FormData(e.currentTarget); const parsed = TimelineEventInput.safeParse({ profileId, name: fields.get('name'), kind: fields.get('kind'), start: fields.get('start'), end: fields.get('end') || null, scopeText: fields.get('scopeText'), note: fields.get('note'), supersedesId: event?.id ?? null }); if (!parsed.success) {
        setMessage('Check the name and date order.');
        return;
    } setPending(true); void fetch('/api/timeline', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(parsed.data) }).then(async (response) => { if (!response.ok)
        throw Error(); const saved = TimelineEvent.parse(await response.json()); if (saved.name !== parsed.data.name || saved.start !== parsed.data.start || saved.end !== parsed.data.end || saved.supersedesId !== parsed.data.supersedesId)
        throw Error(); onSaved(); }).catch(() => setMessage('The save could not be confirmed. Reload before trying again.')).finally(() => setPending(false)); }}>
    <label>Name<input name="name" required maxLength={200} defaultValue={event?.name}/></label><label>Kind<select name="kind" defaultValue={event?.kind ?? 'promotion'}>{TimelineManualKind.options.map((kind) => <option key={kind}>{kind}</option>)}</select></label><label>Starts<input name="start" type="date" required defaultValue={event?.start ?? start}/></label><label>Ends<input name="end" type="date" defaultValue={event?.end ?? ''}/></label><label>Scope (recorded only)<input name="scopeText" defaultValue={event?.scopeText ?? ''}/></label><label>Note<textarea name="note" defaultValue={event?.note ?? ''}/></label><Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save event'}</Button><Button onClick={onClose}>Cancel</Button><p role="status">{message}</p></form></section>;
}
