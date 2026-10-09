import { loadDotenvSafely, McpToolError } from '@chrischall/mcp-utils';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthManager, looksUnauthenticated, PortalHttpError, throwIfEdgeBlocked } from './auth.js';
import { FetchTransport, PORTAL_ORIGIN, type PortalResponse, type PortalTransport } from './transport.js';

// Load `.env` next to the compiled entry point. `loadDotenvSafely` never throws;
// the try/catch additionally guards non-Node runtimes where `import.meta.url` is
// undefined. Real env vars win (`override: false`).
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  await loadDotenvSafely({ path: join(__dirname, '..', '.env'), override: false });
} catch {
  /* v8 ignore next -- only reached in a non-Node runtime with no .env to load */
}

/**
 * A fresh login still landed on the login page — the session will not stick.
 * Its own class so the healthcheck can report `session_expired`.
 */
export class SessionNotReestablishedError extends McpToolError {
  constructor(message: string, opts: { hint: string }) {
    super(message, opts);
    this.name = 'SessionNotReestablishedError';
  }
}

/** Metronic KTDatatable envelope: `{ meta, qs, data[] }`. */
export interface DatatableMeta {
  page: number;
  pages: number;
  perpage: number;
  total: number;
  sort: string;
  field: string;
  rowIds?: number[];
}
export interface DatatableResponse<T = Record<string, unknown>> {
  meta: DatatableMeta;
  qs: string;
  data: T[];
}

export interface DatatableQuery {
  page?: number;
  perpage?: number;
  sortField?: string;
  sortDir?: 'asc' | 'desc';
  /** Per-column filters, e.g. `{ status: 'missing' }` or `{ generalSearch: 'foo' }`. */
  query?: Record<string, string>;
}

/** An authenticated page whose GET sets Django's csrftoken cookie. */
const CSRF_MINT_PATH = '/accounts/';

export interface ClientOptions {
  transport?: PortalTransport;
  auth?: AuthManager;
}

// Thin, tool-facing API over the transport + AuthManager. HTML reads go through
// fetchHtml(); the Metronic datatable JSON endpoints through datatable(); Django
// form writes through write(). Every path ensures a live session and retries once
// across a re-login if the response looks unauthenticated. All POSTs carry the
// Django CSRF token (X-CSRFToken = csrftoken cookie) plus Origin/Referer.
export class CrownTownClient {
  private readonly transport: PortalTransport;
  private readonly auth: AuthManager;

  constructor(opts: ClientOptions = {}) {
    this.transport = opts.transport ?? new FetchTransport();
    this.auth = opts.auth ?? new AuthManager(this.transport);
  }

  /** Which credential route is configured (`session_cookie` / `password`), or null. Never the value. */
  credentialSource(): string | null {
    return this.auth.credentialSource;
  }

  async fetchHtml(path: string): Promise<string> {
    return (await this.requestWithSession('GET', path)).body;
  }

  /** POST a Metronic KTDatatable query and return the parsed `{meta,qs,data}` JSON. */
  async datatable<T = Record<string, unknown>>(path: string, q: DatatableQuery = {}): Promise<DatatableResponse<T>> {
    const params = new URLSearchParams();
    params.set('pagination[page]', String(q.page ?? 1));
    params.set('pagination[perpage]', String(q.perpage ?? 20));
    if (q.sortField) {
      params.set('sort[field]', q.sortField);
      params.set('sort[sort]', q.sortDir ?? 'desc');
    }
    for (const [k, v] of Object.entries(q.query ?? {})) {
      if (v !== undefined && v !== '') params.set(`query[${k}]`, v);
    }
    const res = await this.requestWithSession('POST', path, params.toString());
    if (!res.contentType.includes('json')) {
      throw new McpToolError(`Crown Town Compost returned a non-JSON response for ${path}.`, {
        hint: 'The portal may have redirected to a login or error page — retry, and verify your credentials if it persists.',
      });
    }
    let parsed: DatatableResponse<T>;
    try {
      parsed = JSON.parse(res.body) as DatatableResponse<T>;
    } catch {
      throw new McpToolError(`Could not parse the Crown Town Compost data response for ${path}.`, {
        hint: 'The endpoint shape may have changed. Re-capture the response.',
      });
    }
    return parsed;
  }

  /** POST a Django form body to `path` and return the raw response (for write tools). */
  async write(path: string, body: string): Promise<PortalResponse> {
    return this.requestWithSession('POST', path, body);
  }

  /**
   * POST a classic Django form WITHOUT following its redirect, so the caller can
   * tell acceptance from rejection: Django answers a valid submission with a
   * 302 (post/redirect/get) and an invalid one with a 200 re-render of the form
   * carrying the field errors. Following the redirect erases that difference.
   * A 302 back to the login page still counts as an expired session.
   */
  async submitForm(path: string, body: string): Promise<PortalResponse> {
    return this.requestWithSession('POST', path, body, 'manual');
  }

  private async requestWithSession(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
    redirect: 'follow' | 'manual' = 'follow',
  ): Promise<PortalResponse> {
    if (method === 'POST') await this.ensureCsrfToken();
    const res = await this.auth.withSession(() => this.send(method, path, body, redirect));
    // A CDN/WAF refusal page never reached the portal: name it, rather than
    // reporting a dead session or a page that "may have moved"
    // (chrischall/mcp-host#1015).
    throwIfEdgeBlocked(res, method, path);
    if (looksUnauthenticated(res)) {
      throw new SessionNotReestablishedError('Crown Town Compost session could not be (re)established after re-login.', {
        hint: 'Your CROWNTOWN_USERNAME / CROWNTOWN_PASSWORD may be wrong, or the session keeps expiring. Verify the credentials.',
      });
    }
    this.auth.absorb(res.setCookie);
    if (res.status >= 400) {
      throw new PortalHttpError(
        res.status,
        `Crown Town Compost request failed: ${method} ${path} -> HTTP ${res.status}`,
        'Retry; if it persists the page may have moved or requires a different account.',
      );
    }
    return res;
  }

  /**
   * Make sure the jar holds a `csrftoken` before a POST. A password login always
   * leaves one, but a supplied CROWNTOWN_SESSION_COOKIE may carry only
   * `sessionid`, and Django 403s a POST with an empty X-CSRFToken. The portal
   * sets the cookie on any authenticated GET, so mint one from the dashboard;
   * if even that yields none, refuse with a hint rather than a bare 403.
   */
  private async ensureCsrfToken(): Promise<void> {
    await this.auth.ensureLogin();
    if (this.auth.csrfToken()) return;
    await this.requestWithSession('GET', CSRF_MINT_PATH);
    if (this.auth.csrfToken()) return;
    throw new McpToolError('Crown Town Compost has no csrftoken cookie for this session, so the portal would reject the POST.', {
      hint: 'Include csrftoken in CROWNTOWN_SESSION_COOKIE (copy the whole Cookie header: "sessionid=…; csrftoken=…"), or set CROWNTOWN_USERNAME and CROWNTOWN_PASSWORD instead.',
    });
  }

  private send(method: 'GET' | 'POST', path: string, body: string | undefined, redirect: 'follow' | 'manual'): Promise<PortalResponse> {
    const headers: Record<string, string> = { Cookie: this.auth.cookieHeader() };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      // Django enforces a Referer/Origin check on HTTPS POSTs and reads the CSRF
      // token from the X-CSRFToken header (= csrftoken cookie). X-Requested-With
      // is what the datatable/AJAX endpoints expect; harmless on form POSTs.
      headers['X-CSRFToken'] = this.auth.csrfToken();
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers.Origin = PORTAL_ORIGIN;
      headers.Referer = path.startsWith('http') ? path : `${PORTAL_ORIGIN}${path}`;
    }
    // Reads follow redirects (so an expired session lands on the login page and
    // is detected by looksUnauthenticated); the datatable/write POSTs also follow
    // so a successful Django 302 resolves to its destination. submitForm() opts
    // out ('manual') because for a form POST the redirect itself is the verdict.
    return this.transport.request({ method, path, headers, body, redirect });
  }
}

/**
 * Module-level singleton for the stdio server (deferred-config-error pattern).
 *
 * This constructor must stay PURE. The singleton below is built while the
 * module graph loads, and sandboxed runtimes forbid async I/O, timers and
 * random-value generation in global scope — a violation fails startup rather
 * than a request. `FetchTransport` only stores a timeout and `AuthManager` only
 * reads env vars, so constructing here is safe.
 */
export const client = new CrownTownClient();
