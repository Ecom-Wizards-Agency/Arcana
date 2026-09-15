import { context } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

const stage = (name: 'request' | 'poll' | 'fetch' | 'load') => ({
  stage: name, lastSucceededAt: null, lastFailedAt: null, lastErrorClass: null, retrying: 0, dead: 0,
});

export const ready = { "view": "ready", "props": { "context": context, "status": { "deadLetters": [], "lifecycle": [], "freshness": [], "jobs": [], "reports": [], "catalogue": [] }, "lane": { "scope": "organisation", "stages": [stage('request'), stage('poll'), stage('fetch'), stage('load')], "blocking": null, "organisationDead": { "total": 0, "byStage": { "request": 0, "poll": 0, "fetch": 0, "load": 0 }, "reRequested": 0, "resolved": 0 }, "profiles": [] } } } satisfies ScreenData;
