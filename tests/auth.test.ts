import { describe, it, expect } from 'vitest';
import { AuthManager, looksUnauthenticated, extractCsrfInput } from '../src/auth.js';
import type { PortalRequest, PortalResponse, PortalTransport } from '../src/transport.js';
import { LOGIN_PAGE_HTML } from './fixtures/pages.js';

function res(partial: Partial<PortalResponse> = {}): PortalResponse {
  return { status: 200, body: '', url: 'https://portal.crowntowncompost.com/accounts/', setCookie: [], contentType: 'text/html', ...partial };
}

/** Records every request and replays scripted responses. */
class MockTransport implements PortalTransport {
  requests: PortalRequest[] = [];
  constructor(private readonly handler: (req: PortalRequest, n: number) => PortalResponse) {}
  async request(req: PortalRequest): Promise<PortalResponse> {
    this.requests.push(req);
    return this.handler(req, this.requests.length);
  }
}

/** A transport whose login handshake succeeds: GET page (csrftoken) then POST → 302 + sessionid. */
function loginOkTransport(after?: (req: PortalRequest, n: number) => PortalResponse | undefined): MockTransport {
  return new MockTransport((req, n) => {
    if (req.method === 'GET' && req.path.includes('/accounts/login/')) {
      return res({ body: LOGIN_PAGE_HTML, setCookie: ['csrftoken=COOKIETOKEN; Path=/'] });
    }
    if (req.method === 'POST' && req.path.includes('/accounts/login/')) {
      return res({ status: 302, location: '/accounts/', setCookie: ['sessionid=SESSION123; Path=/; HttpOnly'] });
    }
    return after?.(req, n) ?? res({ body: '<h1>dashboard</h1>' });
  });
}

describe('looksUnauthenticated', () => {
  it('detects a redirect to the login URL', () => {
    expect(looksUnauthenticated(res({ url: 'https://portal.crowntowncompost.com/accounts/login/?next=/accounts/' }))).toBe(true);
  });

  it('detects the login page rendered with a 200', () => {
    expect(looksUnauthenticated(res({ body: LOGIN_PAGE_HTML }))).toBe(true);
  });

  it('detects a manual 3xx whose Location is the login page', () => {
    expect(looksUnauthenticated(res({ status: 302, location: '/accounts/login/?next=/accounts/' }))).toBe(true);
  });

  it('treats a normal authenticated page as signed in', () => {
    expect(looksUnauthenticated(res({ body: '<h1>Dashboard</h1>' }))).toBe(false);
  });
});

describe('extractCsrfInput', () => {
  it('pulls the hidden csrfmiddlewaretoken value', () => {
    expect(extractCsrfInput(LOGIN_PAGE_HTML)).toBe('FORMTOKEN123');
  });

  it('returns null when the page has no CSRF field', () => {
    expect(extractCsrfInput('<p>no form</p>')).toBeNull();
  });
});

describe('AuthManager login', () => {
  it('fetches the login page first to obtain the CSRF token', async () => {
    const t = loginOkTransport();
    await new AuthManager(t, { username: 'u', password: 'p' }).ensureLogin();
    expect(t.requests[0].method).toBe('GET');
    expect(t.requests[0].path).toContain('/accounts/login/');
  });

  it('posts credentials with the CSRF token, Origin and Referer (Django rejects POSTs without them)', async () => {
    const t = loginOkTransport();
    await new AuthManager(t, { username: 'user@example.com', password: 'secret' }).ensureLogin();
    const post = t.requests.find((r) => r.method === 'POST')!;
    const body = new URLSearchParams(post.body!);
    expect(body.get('username')).toBe('user@example.com');
    expect(body.get('password')).toBe('secret');
    expect(body.get('csrfmiddlewaretoken')).toBe('FORMTOKEN123');
    expect(post.headers?.['X-CSRFToken']).toBe('COOKIETOKEN');
    expect(post.headers?.Origin).toBe('https://portal.crowntowncompost.com');
    expect(post.headers?.Referer).toContain('/accounts/login/');
  });

  it('reads the 302 Set-Cookie manually so the HttpOnly sessionid is captured', async () => {
    const t = loginOkTransport();
    const auth = new AuthManager(t, { username: 'u', password: 'p' });
    await auth.ensureLogin();
    expect(t.requests.find((r) => r.method === 'POST')!.redirect).toBe('manual');
    expect(auth.cookieHeader()).toContain('sessionid=SESSION123');
    expect(auth.csrfToken()).toBe('COOKIETOKEN');
  });

  it('throws a credential error when the portal re-renders the login page (bad password)', async () => {
    const t = new MockTransport((req) =>
      req.method === 'GET'
        ? res({ body: LOGIN_PAGE_HTML, setCookie: ['csrftoken=COOKIETOKEN; Path=/'] })
        : res({ status: 200, body: LOGIN_PAGE_HTML }),
    );
    await expect(new AuthManager(t, { username: 'u', password: 'bad' }).ensureLogin()).rejects.toThrow(/login failed/i);
  });

  it('throws a credential error when a 302 leads back to the login page', async () => {
    const t = new MockTransport((req) =>
      req.method === 'GET'
        ? res({ body: LOGIN_PAGE_HTML, setCookie: ['csrftoken=COOKIETOKEN; Path=/'] })
        : res({ status: 302, location: '/accounts/login/?next=/accounts/' }),
    );
    await expect(new AuthManager(t, { username: 'u', password: 'p' }).ensureLogin()).rejects.toThrow(/login failed/i);
  });

  it('defers the missing-credential error to first use and never hits the network', async () => {
    const t = new MockTransport(() => res());
    const auth = new AuthManager(t, { username: undefined, password: undefined });
    await expect(auth.ensureLogin()).rejects.toThrow(/CROWNTOWN_USERNAME and CROWNTOWN_PASSWORD/);
    expect(t.requests).toHaveLength(0);
  });

  it('logs in only once for concurrent callers (single-flight)', async () => {
    const t = loginOkTransport();
    const auth = new AuthManager(t, { username: 'u', password: 'p' });
    await Promise.all([auth.ensureLogin(), auth.ensureLogin(), auth.ensureLogin()]);
    expect(t.requests.filter((r) => r.method === 'POST' && r.path.includes('/accounts/login/'))).toHaveLength(1);
  });
});
