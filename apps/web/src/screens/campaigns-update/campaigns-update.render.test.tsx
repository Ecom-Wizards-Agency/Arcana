// @vitest-environment jsdom
import { verifyScreen } from '../render-test-support';
import { campaignVisualCases } from '../campaigns/visual-cases';
import { descriptor } from './descriptor';
verifyScreen(descriptor, campaignVisualCases.filter((item) => item.screen === descriptor.id).map((item) => ({ ...item, name: item.key })));
