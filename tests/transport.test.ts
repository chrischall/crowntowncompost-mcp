import { describe, it, expect, vi, afterEach } from 'vitest';
import { ResponseTooLargeError } from '@chrischall/mcp-utils';
import { FetchTransport, MAX_RESPONSE_BYTES, PORTAL_ORIGIN } from '../src/transport.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// A streamed body with no Content-Length, so the cap has to be enforced while
// reading rather than refused up front.
function streamOf(totalBytes: number, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  if (!Number.isFinite(totalBytes)) throw new Error('streamOf needs a finite size');
  let sent = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (sent >= totalBytes) return ctrl.close();
      const n = Math.min(chunk, totalBytes - sent);
      sent += n;
      ctrl.enqueue(new Uint8Array(n).fill(0x61));
    },
  });
}

describe('FetchTransport', () => {
  it('returns status, body, cookies, location and content-type unchanged', async () => {
    const headers = new Headers({ 'content-type': 'Text/HTML; charset=utf-8', location: '/accounts/login/' });
    headers.append('set-cookie', 'sessionid=abc; Path=/');
    headers.append('set-cookie', 'csrftoken=def; Path=/');
    const fetchMock = vi.fn(async () => new Response('<p>hi</p>', { status: 302, headers }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await new FetchTransport().request({ method: 'POST', path: '/accounts/login/', body: 'a=1', redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.body).toBe('<p>hi</p>');
    expect(res.setCookie).toEqual(['sessionid=abc; Path=/', 'csrftoken=def; Path=/']);
    expect(res.location).toBe('/accounts/login/');
    expect(res.contentType).toBe('text/html; charset=utf-8');
    expect(res.url).toBe(`${PORTAL_ORIGIN}/accounts/login/`);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${PORTAL_ORIGIN}/accounts/login/`);
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('POST');
  });

  it('refuses a response body larger than the cap instead of buffering it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(streamOf(MAX_RESPONSE_BYTES + 1), { status: 200 })));
    await expect(new FetchTransport().request({ method: 'GET', path: '/dashboard/' })).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it('refuses an oversized Content-Length before reading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 200, headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } })),
    );
    await expect(new FetchTransport().request({ method: 'GET', path: '/dashboard/' })).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it('reads a body at the cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(streamOf(MAX_RESPONSE_BYTES), { status: 200 })));
    const res = await new FetchTransport().request({ method: 'GET', path: '/dashboard/' });
    expect(res.body.length).toBe(MAX_RESPONSE_BYTES);
  });
});
