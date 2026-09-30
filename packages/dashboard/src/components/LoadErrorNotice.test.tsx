import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadErrorNotice, softFail } from './LoadErrorNotice';

describe('LoadErrorNotice (W1: a failed API call is never an empty page)', () => {
  it('records the failed section and returns the fallback', () => {
    const failed: string[] = [];
    expect(softFail(failed, 'memory stats', null)(new Error('HTTP 503'))).toBeNull();
    expect(failed).toEqual(['memory stats: HTTP 503']);
  });

  it('renders nothing without failures and names every failed section otherwise', () => {
    expect(renderToStaticMarkup(<LoadErrorNotice failed={[]} />)).toBe('');
    const html = renderToStaticMarkup(<LoadErrorNotice failed={['a: x', 'b: y']} />);
    expect(html).toContain('Could not load 2 sections');
    expect(html).toContain('b: y');
  });
});
