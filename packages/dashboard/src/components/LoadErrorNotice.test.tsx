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

describe('UXE-08: the request id of a failed call is shown', () => {
  it('UXE-08: request id renders next to the failed section', () => {
    const failed: string[] = [];
    const error = Object.assign(new Error('Explainer not configured'), { status: 503, request_id: 'req-503' });
    softFail(failed, 'explainer', null)(error);
    expect(failed).toEqual(['explainer: Explainer not configured (request id req-503)']);
    expect(renderToStaticMarkup(<LoadErrorNotice failed={failed} />)).toContain('explainer: Explainer not configured (request id req-503)');
  });

  it('UXE-08: without a request id the line is unchanged', () => {
    const failed: string[] = [];
    softFail(failed, 'explainer', null)(Object.assign(new Error('boom'), { status: 500 }));
    expect(failed).toEqual(['explainer: boom']);
  });
});
