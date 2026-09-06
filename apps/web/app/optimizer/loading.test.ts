import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import OptimizerLoading from './loading';

describe('optimizer route loading state', () => {
  it('stands in for the loaded page at the loaded page’s width', () => {
    const markup = renderToStaticMarkup(OptimizerLoading());

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Loading campaigns, group settings');
    // The loaded optimizer is full width. A skeleton in the shared 84rem
    // reading column flashes a narrow page and then jumps wider under the
    // operator, which is the layout it is supposed to be standing in for.
    expect(markup).toContain('width:100%');
    expect(markup).not.toContain('max-width:84rem');
    expect(markup).not.toMatch(/<(button|input|select)\b/);
  });
});
