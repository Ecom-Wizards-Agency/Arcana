import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, beforeEach, afterEach } from 'vitest';
import { verifyScreen as verify, type RenderCase } from '../render-test-support';
import type { ScreenMetadata } from '../types';

/** Run the original state assertions in both supported themes. */
export function verifyScreen(descriptor: ScreenMetadata, cases: readonly RenderCase[]) {
  for (const theme of ['light', 'dark']) describe(theme, () => {
    beforeEach(() => { document.documentElement.dataset['theme'] = theme; });
    afterEach(() => { delete document.documentElement.dataset['theme']; });
    verify(descriptor, cases.map((test, index) => ({ ...test, render: () => {
      const view = test.render();
      const output = process.env['WP272_VISUAL_DIR'];
      if (output) {
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, `${descriptor.id}-${theme}-${test.state}-${index}.html`), renderToStaticMarkup(view));
      }
      return view;
    } })));
  });
}
