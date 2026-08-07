import { describe, it, expect } from 'vitest';
import { CrownTownClient, createDirectClient } from '../src/client.js';
import { AuthManager } from '../src/auth.js';
import type { PortalRequest, PortalResponse, PortalTransport } from '../src/transport.js';
import { LOGIN_PAGE_HTML } from './fixtures/pages.js';

function res(partial: Partial<PortalResponse> = {}): PortalResponse {
  return { status: 200, body: '', url: 'https://portal.crowntowncompost.com/accounts/', setCookie: [], contentType: 'text/html', ...partial };
}
const json = (obj: unknown, partial: Partial<PortalResponse> = {}): PortalResponse =>
  res({ body: JSON.stringify(obj), contentType: 'application/json', ...partial });

class MockTransport implements PortalTransport {
  requests: PortalRequest[] = [];
  constructor(private readonly handler: (req: PortalRequest, n: number) => PortalResponse) {}
  async request(req: PortalRequest): Promise<PortalResponse> {
    this.requests.push(req);
    return this.handler(req, this.requests.length);
  }
  /** Non-login requests only — the ones a tool actually made. */
  get appRequests(): PortalRequest[] {
    return this.requests.filter((r) => !r.path.includes('/accounts/login/'));
  }
}

/** Wire a client whose login handshake always succeeds, delegating app requests to `handler`. */
function clientWith(handler: (req: PortalRequest, n: number) => PortalResponse): { client: CrownTownClient; transport: MockTransport } {
  let appCalls = 0;
  const transport = new MockTransport((req) => {
    if (req.path.includes('/accounts/login/')) {
      return req.method === 'GET'
        ? res({ body: LOGIN_PAGE_HTML, setCookie: ['csrftoken=CSRFCOOKIE; Path=/'] })
        : res({ status: 302, location: '/accounts/', setCookie: ['sessionid=SESSION; Path=/; HttpOnly'] });
    }
    return handler(req, ++appCalls);
  });
  const auth = new AuthManager(transport, { username: 'u', password: 'p' });
  return { client: new CrownTownClient({ transport, auth }), transport };
}

const DATATABLE_BODY = {
  meta: { page: 1, pages: 3, perpage: 20, total: 61, sort: 'desc', field: 'date' },
  qs: 'x',
  data: [{ RecordID: 1, status: 'Success', date: 'Friday, Jul 31, 2026' }],
};

describe('CrownTownClient.datatable', () => {
  it('sends the Metronic KTDatatable pagination/sort grammar', async () => {
    const { client, transport } = clientWith(() => json(DATATABLE_BODY));
    await client.datatable('/accounts/stops/api/', { page: 2, perpage: 50, sortField: 'date', sortDir: 'desc' });
    const body = new URLSearchParams(transport.appRequests[0].body!);
    expect(body.get('pagination[page]')).toBe('2');
    expect(body.get('pagination[perpage]')).toBe('50');
    expect(body.get('sort[field]')).toBe('date');
    expect(body.get('sort[sort]')).toBe('desc');
  });

  it('passes per-column filters as query[<field>]', async () => {
    const { client, transport } = clientWith(() => json(DATATABLE_BODY));
    await client.datatable('/accounts/stops/api/', { query: { status: 'missing' } });
    expect(new URLSearchParams(transport.appRequests[0].body!).get('query[status]')).toBe('missing');
  });

  it('omits empty filter values rather than sending query[x]=', async () => {
    const { client, transport } = clientWith(() => json(DATATABLE_BODY));
    await client.datatable('/accounts/stops/api/', { query: { status: '' } });
    expect(new URLSearchParams(transport.appRequests[0].body!).has('query[status]')).toBe(false);
  });

  it('attaches the Django CSRF token, Origin and Referer to the POST', async () => {
    const { client, transport } = clientWith(() => json(DATATABLE_BODY));
    await client.datatable('/accounts/stops/api/');
    const h = transport.appRequests[0].headers!;
    expect(h['X-CSRFToken']).toBe('CSRFCOOKIE');
    expect(h['X-Requested-With']).toBe('XMLHttpRequest');
    expect(h.Origin).toBe('https://portal.crowntowncompost.com');
    expect(h.Referer).toBe('https://portal.crowntowncompost.com/accounts/stops/api/');
    expect(h.Cookie).toContain('sessionid=SESSION');
  });

  it('returns the parsed {meta,qs,data} envelope', async () => {
    const { client } = clientWith(() => json(DATATABLE_BODY));
    const out = await client.datatable('/accounts/stops/api/');
    expect(out.meta.total).toBe(61);
    expect(out.data).toHaveLength(1);
  });

  // A non-JSON 2xx from these endpoints is a login/error interstitial — never
  // JSON.parse it blind.
  it('throws an actionable error when the endpoint answers non-JSON', async () => {
    const { client } = clientWith(() => res({ body: '<html>oops</html>', contentType: 'text/html' }));
    await expect(client.datatable('/accounts/stops/api/')).rejects.toThrow(/non-JSON/i);
  });

  it('throws a parse error on malformed JSON', async () => {
    const { client } = clientWith(() => res({ body: '{not json', contentType: 'application/json' }));
    await expect(client.datatable('/accounts/stops/api/')).rejects.toThrow(/could not parse/i);
  });
});

describe('CrownTownClient session handling', () => {
  it('logs in before the first request and reuses the session afterwards', async () => {
    const { client, transport } = clientWith(() => res({ body: '<h1>ok</h1>' }));
    await client.fetchHtml('/accounts/');
    await client.fetchHtml('/accounts/update/');
    expect(transport.requests.filter((r) => r.method === 'POST' && r.path.includes('/accounts/login/'))).toHaveLength(1);
  });

  // The portal signals expiry by serving the login page; the manager must
  // re-login and replay the request EXACTLY once.
  it('re-logs-in and replays the request once when the session has expired', async () => {
    let served = 0;
    const { client, transport } = clientWith(() => {
      served += 1;
      return served === 1 ? res({ body: LOGIN_PAGE_HTML }) : res({ body: '<h1>dashboard</h1>' });
    });
    const html = await client.fetchHtml('/accounts/');
    expect(html).toContain('dashboard');
    expect(transport.appRequests).toHaveLength(2);
    expect(transport.requests.filter((r) => r.method === 'POST' && r.path.includes('/accounts/login/'))).toHaveLength(2);
  });

  it('surfaces a sign-in error when the session still looks expired after the replay', async () => {
    const { client } = clientWith(() => res({ body: LOGIN_PAGE_HTML }));
    await expect(client.fetchHtml('/accounts/')).rejects.toThrow(/could not be \(re\)established/i);
  });

  it('surfaces upstream HTTP errors with the method and path', async () => {
    const { client } = clientWith(() => res({ status: 500, body: 'boom' }));
    await expect(client.fetchHtml('/accounts/')).rejects.toThrow(/HTTP 500/);
  });

  it('does not attach CSRF/POST headers to reads', async () => {
    const { client, transport } = clientWith(() => res({ body: 'ok' }));
    await client.fetchHtml('/accounts/');
    const h = transport.appRequests[0].headers!;
    expect(h['X-CSRFToken']).toBeUndefined();
    expect(h['Content-Type']).toBeUndefined();
    expect(h.Cookie).toContain('sessionid=SESSION');
  });
});

describe('createDirectClient', () => {
  // The per-user seam: each call must mint its OWN transport + AuthManager, so
  // two concurrent sessions never share a cookie jar. Its only previous
  // exercise went with the Worker suite.
  it('mints independent clients that do not share auth state', () => {
    const a = createDirectClient({ username: 'a@example.com', password: 'pw-a' });
    const b = createDirectClient({ username: 'b@example.com', password: 'pw-b' });
    expect(a).toBeInstanceOf(CrownTownClient);
    expect(b).toBeInstanceOf(CrownTownClient);
    expect(a).not.toBe(b);
    // Distinct AuthManager instances — a shared one is the cookie-jar bug.
    expect((a as unknown as { auth: AuthManager }).auth).not.toBe(
      (b as unknown as { auth: AuthManager }).auth,
    );
  });
});
