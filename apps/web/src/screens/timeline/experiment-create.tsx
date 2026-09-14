'use client';

/** Guided experiment setup with optional, profile-scoped entity selectors. */
import { useEffect, useMemo, useRef, useState } from 'react';
import './timeline.css';
import type { FormEvent } from 'react';
import type {
  ExperimentScopeOptions,
  ProfileOption,
} from '../../../src/experiments/data';
import {
  EXPERIMENT_METRIC_OPTIONS,
  EXPERIMENT_TYPE_OPTIONS,
  METRIC_LABELS,
  TYPE_LABELS,
} from '../../../src/experiments/labels';
import {
  Banner,
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
} from '../../../src/ui/primitives';

export interface PrefilledScope {
  campaignIds: string[];
  adGroupIds: string[];
  targetIds: string[];
  asins: string[];
  searchTerms: string[];
}

interface SelectorOption {
  id: string;
  label: string;
  secondary: string;
  available: boolean;
}

const DISPLAY_LIMIT = 50;

const cleanList = (values: readonly string[]): string[] =>
  Array.from(new Set(values.map((entry) => entry.trim()).filter((entry) => entry !== '')));

const toList = (value: string): string[] => cleanList(value.split(','));

const campaignsFrom = (options: ExperimentScopeOptions): SelectorOption[] =>
  options.campaigns.map((campaign) => ({
    id: campaign.id,
    label: campaign.name,
    secondary: `Campaign ID ${campaign.id}`,
    available: campaign.available,
  }));

const productsFrom = (options: ExperimentScopeOptions): SelectorOption[] =>
  options.products.map((product) => ({
    id: product.asin,
    label: product.name ?? (product.sku === null ? 'Unnamed synced product' : `SKU ${product.sku}`),
    secondary: `ASIN ${product.asin}`,
    available: product.available,
  }));

export function SearchableScopeSelector({
  id,
  label,
  hint,
  searchLabel,
  options,
  selectedIds,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  searchLabel: string;
  options: readonly SelectorOption[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const optionIds = useMemo(() => new Set(options.map((option) => option.id)), [options]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = options.filter((option) => {
    if (!option.available && !selected.has(option.id)) return false;
    if (normalizedQuery === '') return true;
    return `${option.label} ${option.secondary} ${option.id}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
  const selectableFiltered = filtered.filter((option) => option.available);
  const shown = filtered.slice(0, DISPLAY_LIMIT);
  const unavailableSelections = selectedIds.filter((selectedId) => {
    const option = options.find((candidate) => candidate.id === selectedId);
    return !optionIds.has(selectedId) || option?.available === false;
  });
  const allFilteredSelected =
    selectableFiltered.length > 0 && selectableFiltered.every((option) => selected.has(option.id));

  const toggle = (optionId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(optionId);
    else next.delete(optionId);
    onChange([...next]);
  };

  const selectAllFiltered = () => {
    const next = new Set(selectedIds);
    for (const option of selectableFiltered) next.add(option.id);
    onChange([...next]);
  };

  return (
    <section className="wa-scope-selector" aria-labelledby={`${id}-title`}>
      <div className="wa-scope-selector__head">
        <div>
          <h3 id={`${id}-title`} className="wa-scope-selector__title">
            {label} <span>Optional</span>
          </h3>
          <p>{hint}</p>
        </div>
        <strong aria-live="polite" data-testid={`${id}-selected-count`}>
          {selectedIds.length} selected
        </strong>
      </div>

      {unavailableSelections.length === 0 ? null : (
        <div className="wa-scope-selector__unavailable" role="status">
          <span>Not in the current sync</span>
          <div>
            {unavailableSelections.map((selectedId) => (
              <span className="wa-scope-selector__unknown" key={selectedId}>
                <code>{selectedId}</code>
                <button
                  type="button"
                  aria-label={`Remove ${selectedId}`}
                  onClick={() => toggle(selectedId, false)}
                >
                  Remove
                </button>
              </span>
            ))}
          </div>
          <small>Preserved from the link or manual entry. Remove it if it no longer belongs.</small>
        </div>
      )}

      <Field label={searchLabel} htmlFor={`${id}-search`}>
        <Input
          id={`${id}-search`}
          type="search"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${label.toLocaleLowerCase()}`}
        />
      </Field>

      <div className="wa-scope-selector__actions">
        <Button
          size="sm"
          onClick={selectAllFiltered}
          disabled={selectableFiltered.length === 0 || allFilteredSelected}
        >
          Select all filtered
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange([])}
          disabled={selectedIds.length === 0}
        >
          Clear selection
        </Button>
        <span aria-live="polite">
          {filtered.length > DISPLAY_LIMIT
            ? `Showing ${DISPLAY_LIMIT} of ${filtered.length} matches`
            : `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`}
        </span>
      </div>

      <div className="wa-scope-selector__list" role="group" aria-label={`${label} choices`}>
        {shown.length === 0 ? (
          <p className="wa-scope-selector__empty">No synced matches for this profile.</p>
        ) : (
          shown.map((option) => (
            <label className="wa-scope-selector__option" key={option.id}>
              <Checkbox
                checked={selected.has(option.id)}
                onChange={(event) => toggle(option.id, event.target.checked)}
                data-testid={`${id}-option-${option.id}`}
              />
              <span>
                <b>{option.label}</b>
                <small>
                  {option.secondary}
                  {option.available ? '' : ' · no longer in current sync'}
                </small>
              </span>
            </label>
          ))
        )}
      </div>
    </section>
  );
}

function ManualIdAdder({
  id,
  label,
  value,
  onChange,
  onAdd,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onAdd: (value: string) => void;
}) {
  return (
    <Field label={label} htmlFor={id} hint="Use only when the entity is missing from the current sync.">
      <div className="wa-experiment-manual-add">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            onAdd(value);
          }}
        />
        <Button size="sm" onClick={() => onAdd(value)} disabled={value.trim() === ''}>
          Add
        </Button>
      </div>
    </Field>
  );
}

export function NewExperimentForm({
  profiles,
  selectedProfileId,
  prefillName,
  scope,
  initialScopeOptions,
}: {
  profiles: ProfileOption[];
  selectedProfileId: string | null;
  prefillName: string;
  scope: PrefilledScope;
  initialScopeOptions: ExperimentScopeOptions;
}) {
  const initialProfileId = selectedProfileId ?? profiles[0]?.id ?? '';
  const [profileId, setProfileId] = useState(initialProfileId);
  const [name, setName] = useState(prefillName);
  const [type, setType] = useState<(typeof EXPERIMENT_TYPE_OPTIONS)[number]>('bid_push');
  const [metric, setMetric] = useState<(typeof EXPERIMENT_METRIC_OPTIONS)[number]>('sales');
  const [hypothesis, setHypothesis] = useState('');
  const [startAt,setStartAt]=useState('');
  const [endAt,setEndAt]=useState('');
  const [campaignIds, setCampaignIds] = useState(cleanList(scope.campaignIds));
  const [asins, setAsins] = useState(cleanList(scope.asins));
  const [adGroups, setAdGroups] = useState(scope.adGroupIds.join(', '));
  const [targets, setTargets] = useState(scope.targetIds.join(', '));
  const [terms, setTerms] = useState(scope.searchTerms.join(', '));
  const [manualCampaign, setManualCampaign] = useState('');
  const [manualAsin, setManualAsin] = useState('');
  const [scopeOptions, setScopeOptions] = useState(initialScopeOptions);
  const [scopeOptionsProfileId, setScopeOptionsProfileId] = useState<string | null>(
    initialProfileId || null,
  );
  const [scopeOptionsStatus, setScopeOptionsStatus] = useState<'ready' | 'loading' | 'error'>(
    'ready',
  );
  const [scopeOptionsMessage, setScopeOptionsMessage] = useState('');
  const [scopeReloadKey, setScopeReloadKey] = useState(0);
  const [startNow, setStartNow] = useState(true);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const scopeRequestId = useRef(0);

  useEffect(() => setReady(true), []);

  useEffect(() => {
    if (profileId === '') {
      setScopeOptions({ campaigns: [], products: [] });
      setScopeOptionsProfileId(null);
      setScopeOptionsStatus('ready');
      setScopeOptionsMessage('');
      return;
    }
    if (scopeOptionsProfileId === profileId && scopeOptionsStatus === 'ready') return;
    if (scopeOptionsStatus === 'error') return;

    const controller = new AbortController();
    const requestId = scopeRequestId.current;
    setScopeOptionsStatus('loading');
    setScopeOptionsMessage('Loading synced scope options…');
    void fetch(`/api/experiments/scope-options?profile=${encodeURIComponent(profileId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | (ExperimentScopeOptions & { error?: string })
          | null;
        if (!response.ok || payload === null) {
          throw new Error(payload?.error ?? 'Could not load synced scope options');
        }
        if (controller.signal.aborted || requestId !== scopeRequestId.current) return;
        setScopeOptions({ campaigns: payload.campaigns, products: payload.products });
        setScopeOptionsProfileId(profileId);
        setScopeOptionsStatus('ready');
        setScopeOptionsMessage('');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestId !== scopeRequestId.current) return;
        setScopeOptions({ campaigns: [], products: [] });
        setScopeOptionsProfileId(null);
        setScopeOptionsStatus('error');
        setScopeOptionsMessage(
          error instanceof Error ? error.message : 'Could not load synced scope options',
        );
      });
    return () => controller.abort();
  }, [profileId, scopeOptionsProfileId, scopeOptionsStatus, scopeReloadKey]);

  const changeProfile = (nextProfileId: string) => {
    if (nextProfileId === profileId) return;
    // Profile-bound scope and its labels move as one state transition. This
    // prevents a new profile heading from ever painting above old selections.
    scopeRequestId.current += 1;
    setProfileId(nextProfileId);
    setCampaignIds([]);
    setAsins([]);
    setAdGroups('');
    setTargets('');
    setTerms('');
    setManualCampaign('');
    setManualAsin('');
    setScopeOptions({ campaigns: [], products: [] });
    setScopeOptionsProfileId(null);
    setScopeOptionsStatus(nextProfileId === '' ? 'ready' : 'loading');
    setScopeOptionsMessage(nextProfileId === '' ? '' : 'Loading synced scope options…');
  };

  const retryScopeOptions = () => {
    scopeRequestId.current += 1;
    setScopeOptions({ campaigns: [], products: [] });
    setScopeOptionsProfileId(null);
    setScopeOptionsStatus('loading');
    setScopeOptionsMessage('Loading synced scope options…');
    setScopeReloadKey((key) => key + 1);
  };

  const addManual = (
    value: string,
    current: readonly string[],
    update: (values: string[]) => void,
    clear: () => void,
  ) => {
    const additions = toList(value);
    if (additions.length === 0) return;
    update(cleanList([...current, ...additions]));
    clear();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const requestedStatus = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('data-status') ?? (startNow ? 'running' : 'planned');
    if (scopeOptionsStatus !== 'ready' || scopeOptionsProfileId !== profileId) return;
    setPending(true);
    setMessage('Creating experiment…');
    void (async () => {
      try {
        const response = await fetch('/api/experiments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            profileId,
            name,
            hypothesis,
            ...(startAt && requestedStatus === 'planned' ? {startAt} : {}),
            endAt: endAt || null,
            type,
            metricFocus: metric,
            status: requestedStatus,
            scope: {
              campaignIds,
              adGroupIds: toList(adGroups),
              targetIds: toList(targets),
              asins,
              searchTerms: toList(terms),
            },
          }),
        });
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          item?: { id: string };
        } | null;
        if (!response.ok || !payload?.item) {
          throw new Error(payload?.error ?? `Could not create the experiment (${response.status})`);
        }
        window.location.href = `/experiments/${payload.item.id}`;
      } catch (error) {
        setPending(false);
        setMessage(error instanceof Error ? error.message : 'Could not create the experiment');
      }
    })();
  };

  const unavailable = !ready || pending || !profileId || scopeOptionsStatus !== 'ready' || scopeOptionsProfileId !== profileId;
  return <main className="tl tl-create" data-interactive={ready ? 'true' : 'false'}>
    <h1 className="tl-accessible-title">Plan an experiment</h1>
    <p className="tl-note">What you think will happen, what you are changing it on, and how you will know. Written before the change, because a hypothesis recorded afterwards is a description.</p>
    {profiles.length === 0 ? <Banner tone="warn" role="alert">Connect and sync an advertising profile before creating an experiment.</Banner> : null}
    {message ? <Banner tone={pending ? 'warn' : 'bad'} role={pending ? 'status' : 'alert'}>{message}</Banner> : null}
    <form onSubmit={submit} className="tl-create-form">
      <Field label="Name" htmlFor="experiment-name"><Input id="experiment-name" required maxLength={200} value={name} data-testid="experiment-name" onChange={(event) => setName(event.target.value)} /></Field>
      <Field label="Hypothesis" htmlFor="experiment-hypothesis" hint="Recorded before the experiment starts and never edited afterwards."><Textarea id="experiment-hypothesis" rows={2} value={hypothesis} data-testid="experiment-hypothesis" onChange={(event) => setHypothesis(event.target.value)} /></Field>
      <div className="tl-form-pair">
        <Field label="Type" htmlFor="experiment-type"><Select id="experiment-type" value={type} data-testid="experiment-type" onChange={(event) => setType(event.target.value as typeof type)}>{EXPERIMENT_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{TYPE_LABELS[option]}</option>)}</Select></Field>
        <Field label="Success measure" htmlFor="experiment-metric"><Select id="experiment-metric" value={metric} data-testid="experiment-metric" onChange={(event) => setMetric(event.target.value as typeof metric)}>{EXPERIMENT_METRIC_OPTIONS.map((option) => <option key={option} value={option}>{METRIC_LABELS[option]}</option>)}</Select></Field>
      </div>
      <div className="tl-form-pair"><Field label="Starts" htmlFor="experiment-start"><Input id="experiment-start" type="date" value={startAt} onChange={(event) => setStartAt(event.target.value)} /></Field><Field label="Ends" htmlFor="experiment-end" hint="Left open while an experiment is still running."><Input id="experiment-end" type="date" min={startAt || undefined} value={endAt} onChange={(event) => setEndAt(event.target.value)} /></Field></div>
      <section data-testid="experiment-scope" aria-busy={scopeOptionsStatus === 'loading'}><h2>What it affects</h2>
        {scopeOptionsMessage ? <Banner tone={scopeOptionsStatus === 'loading' ? 'info' : 'bad'} role={scopeOptionsStatus === 'loading' ? 'status' : 'alert'}>{scopeOptionsMessage}{scopeOptionsStatus === 'error' ? <Button onClick={retryScopeOptions}>Retry loading</Button> : null}</Banner> : null}
        <details className="tl-scope-picker"><summary>Campaigns <b>{campaignIds.length} selected</b><span>picker</span></summary><SearchableScopeSelector key={`campaigns-${profileId}`} id="scope-campaigns" label="Campaigns" hint="Search the active profile by campaign name or Amazon campaign ID." searchLabel="Find campaigns" options={campaignsFrom(scopeOptions)} selectedIds={campaignIds} onChange={setCampaignIds} /></details>
        {campaignIds.filter((id) => !scopeOptions.campaigns.some((option) => option.id === id)).map((id) => <span className="tl-unavailable-scope" key={id}>{id}</span>)}
        <div className="tl-scope-text"><label htmlFor="scope-ad-groups">Ad groups <span>free text</span></label><Input id="scope-ad-groups" value={adGroups} data-testid="scope-ad-groups" onChange={(event) => setAdGroups(event.target.value)} /></div>
        <div className="tl-scope-text"><label htmlFor="scope-targets">Targets <span>free text</span></label><Input id="scope-targets" value={targets} data-testid="scope-targets" onChange={(event) => setTargets(event.target.value)} /></div>
        <details className="tl-scope-picker"><summary>Products <b>{asins.length} selected</b><span>picker</span></summary><SearchableScopeSelector key={`products-${profileId}`} id="scope-products" label="Products" hint="Search advertised products synchronized from Amazon." searchLabel="Find products by name, SKU, or ASIN" options={productsFrom(scopeOptions)} selectedIds={asins} onChange={setAsins} /></details>
        <div className="tl-scope-text"><label htmlFor="scope-terms">Search terms <span>free text</span></label><Input id="scope-terms" value={terms} data-testid="scope-terms" onChange={(event) => setTerms(event.target.value)} /></div>
      </section>
      <aside className="tl-scope-disclosure"><strong>Not every part of the scope is measured</strong><p>Scope is optional. Campaigns, ad groups and targets compute the effect. Products and search terms are recorded only. Campaigns and products are chosen from a real list; the other three rows accept typed identifiers. A typo is stored as written.</p></aside>
      <footer className="tl-create-actions"><Button type="submit" variant="primary" data-status="planned" disabled={unavailable}>Save as planned</Button><Button type="submit" data-status="running" data-testid="experiment-submit" disabled={unavailable}>{pending ? 'Creating…' : 'Save and start now'}</Button><span>An experiment is born either planned or running. Nothing else is allowed at creation.</span></footer>
      <details data-testid="experiment-scope-advanced"><summary>Advanced: profile and manual identifiers</summary><Field label="Profile" htmlFor="experiment-profile"><Select id="experiment-profile" value={profileId} data-testid="experiment-profile" onChange={(event) => changeProfile(event.target.value)}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} · {profile.countryCode}</option>)}</Select></Field><ManualIdAdder id="manual-campaign-id" label="Add campaign ID manually" value={manualCampaign} onChange={setManualCampaign} onAdd={(value) => addManual(value, campaignIds, setCampaignIds, () => setManualCampaign(''))} /><ManualIdAdder id="manual-product-asin" label="Add ASIN manually" value={manualAsin} onChange={setManualAsin} onAdd={(value) => addManual(value, asins, setAsins, () => setManualAsin(''))} /><label><Checkbox checked={startNow} data-testid="experiment-start-now" onChange={(event) => setStartNow(event.target.checked)} />Start tracking now when submitting with Enter</label></details>
    </form>
  </main>;
}
