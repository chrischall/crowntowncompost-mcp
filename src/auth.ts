import { readEnvVar, McpToolError, CookieJar } from '@chrischall/mcp-utils';
import { CookieSessionManager } from '@chrischall/mcp-utils/session';
import { parse } from 'node-html-parser';
import { PORTAL_ORIGIN, type PortalResponse, type PortalTransport } from './transport.js';

const LOGIN_PATH = '/accounts/login/?next=/accounts/';

export interface AuthOptions {
  username?: string;
  password?: string;
}

/** The cookie session the manager mints and hands back to callers: the live jar. */
interface PortalSession {
  jar: CookieJar;
}

// Sentinel marking the deferred config error (missing creds) so the manager
// caches it as *permanent* — every later ensure() rethrows it rather than
// retrying a login that can never succeed without new config.
const CONFIG_ERROR_MARKER = '__crowntown_missing_creds__';

// The Django portal signals an expired session by redirecting an authed request
// back to /accounts/login/ (or rendering that login page with a 200). Detect it
// from the final URL, the login-page body markers, or a manual 3xx Location.
const LOGIN_URL_RE = /\/accounts\/login\//i;
const LOGIN_BODY_RE = /Username or Email|m_login_signin_submit|id=['"]?resetForm/i;
export function looksUnauthenticated(res: PortalResponse): boolean {
  return LOGIN_URL_RE.test(res.url) || LOGIN_BODY_RE.test(res.body) || (res.location ? LOGIN_URL_RE.test(res.location) : false);
}

/** Pull Django's hidden CSRF form token out of a rendered page, if present. */
export function extractCsrfInput(html: string): string | null {
  const el = parse(html).querySelector('input[name="csrfmiddlewaretoken"]');
  return el?.getAttribute('value') ?? null;
}

// Owns the Django username/password login and the resulting cookie session.
// Deferred config: constructing with no creds is fine; the error surfaces at
// ensureLogin(). The single-flight login + invalidate/re-login machinery and the
// one-replay-on-expiry for the request path are delegated to the shared
// CookieSessionManager.
export class AuthManager {
  private readonly username: string | null;
  private readonly password: string | null;
  private readonly configError: Error | null;
  private readonly session: CookieSessionManager<PortalSession, PortalResponse>;

  constructor(private readonly transport: PortalTransport, opts: AuthOptions = {}) {
    const username = opts.username ?? readEnvVar('CROWNTOWN_USERNAME') ?? null;
    const password = opts.password ?? readEnvVar('CROWNTOWN_PASSWORD') ?? null;
    this.username = username;
    this.password = password;
    this.configError = username && password ? null : new Error(
      'CROWNTOWN_USERNAME and CROWNTOWN_PASSWORD environment variables are required',
    );
    this.session = new CookieSessionManager<PortalSession, PortalResponse>({
      login: () => this.doLogin(),
      isExpired: looksUnauthenticated,
      isPermanentError: (err) =>
        err instanceof Error && (err as { [CONFIG_ERROR_MARKER]?: true })[CONFIG_ERROR_MARKER] === true,
    });
  }

  /**
   * Run an authed request through the manager's expiry-replay: it ensures a live
   * session, runs `call`, and on a redirect-away-to-login (isExpired) invalidates
   * + single-flight re-logs-in + replays `call` EXACTLY once.
   */
  withSession(call: (session: PortalSession) => Promise<PortalResponse>): Promise<PortalResponse> {
    return this.session.withSession(call);
  }

  cookieHeader(): string {
    return this.session.current?.jar.header() ?? '';
  }

  /** The Django CSRF token from the session jar (sent as X-CSRFToken on POSTs). */
  csrfToken(): string {
    return this.session.current?.jar.get('csrftoken') ?? '';
  }

  hasSession(): boolean {
    const jar = this.session.current?.jar;
    return jar !== undefined && jar.size > 0;
  }

  async ensureLogin(): Promise<void> {
    await this.session.ensure();
  }

  /** Absorb refreshed cookies from a normal response (rotated csrftoken/sessionid). */
  absorb(setCookie: string[]): void {
    if (setCookie.length) this.session.current?.jar.absorb(setCookie);
  }

  invalidate(): void {
    this.session.invalidate();
  }

  private async doLogin(): Promise<PortalSession> {
    if (this.configError) {
      (this.configError as { [CONFIG_ERROR_MARKER]?: true })[CONFIG_ERROR_MARKER] = true;
      throw this.configError;
    }
    const jar = new CookieJar();

    // 1. GET the login page to obtain the csrftoken cookie + the hidden form token.
    const page = await this.transport.request({ method: 'GET', path: LOGIN_PATH, redirect: 'follow' });
    jar.absorb(page.setCookie);
    const formToken = extractCsrfInput(page.body);
    const cookieToken = jar.get('csrftoken');
    const csrf = formToken ?? cookieToken ?? '';

    // 2. POST the credentials. Django enforces a Referer/Origin check on HTTPS
    // POSTs and accepts the CSRF token via the csrfmiddlewaretoken field OR the
    // X-CSRFToken header — send both, plus Origin/Referer, or the POST is rejected
    // with 403 "CSRF verification failed" before the credentials are even checked.
    const body = new URLSearchParams({
      csrfmiddlewaretoken: csrf,
      username: this.username!,
      password: this.password!,
      next: '/accounts/',
    }).toString();
    const res = await this.transport.request({
      method: 'POST',
      path: LOGIN_PATH,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: jar.header(),
        'X-CSRFToken': cookieToken ?? csrf,
        Origin: PORTAL_ORIGIN,
        Referer: `${PORTAL_ORIGIN}${LOGIN_PATH}`,
      },
      body,
      redirect: 'manual',
    });
    jar.absorb(res.setCookie);

    // Success = a 302 whose Location is NOT the login page (Django redirects to
    // `next` on success, re-renders the login page with 200 on bad credentials).
    const redirectedAway =
      (res.status === 301 || res.status === 302) && !!res.location && !LOGIN_URL_RE.test(res.location);
    if (!redirectedAway || !jar.get('sessionid')) {
      const status = res.status;
      throw new McpToolError(
        'Crown Town Compost login failed — check your CROWNTOWN_USERNAME / CROWNTOWN_PASSWORD.',
        {
          hint:
            status === 403
              ? 'The portal rejected the login request (CSRF/Referer). This is usually transient — retry.'
              : 'Verify the username/email and password are correct for portal.crowntowncompost.com.',
        },
      );
    }
    return { jar };
  }
}
