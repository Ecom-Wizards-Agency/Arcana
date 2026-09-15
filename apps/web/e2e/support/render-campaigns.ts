import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
Object.assign(globalThis, { React });
const { campaignVisualCases } = await import('../../src/screens/campaigns/visual-cases');
const states = campaignVisualCases.map((item) => ({ name: `${item.screen}-${item.key}`, text: item.text, html: renderToStaticMarkup(item.render()) }));
if (new Set(states.map((item) => item.name)).size !== states.length) throw new Error('Duplicate campaign visual state');
process.stdout.write(JSON.stringify({ count: campaignVisualCases.length, states }));
