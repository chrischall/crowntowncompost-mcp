import { loadDotenvSafely, McpToolError } from '@chrischall/mcp-utils';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthManager, looksUnauthenticated } from './auth.js';
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

  private async requestWithSession(method: 'GET' | 'POST', path: string, body?: string): Promise<PortalResponse> {
    const res = await this.auth.withSession(() => this.send(method, path, body));
    if (looksUnauthenticated(res)) {
      throw new McpToolError('Crown Town Compost session could not be (re)established after re-login.', {
        hint: 'Your CROWNTOWN_USERNAME / CROWNTOWN_PASSWORD may be wrong, or the session keeps expiring. Verify the credentials.',
      });
    }
    this.auth.absorb(res.setCookie);
    if (res.status >= 400) {
      throw new McpToolError(`Crown Town Compost request failed: ${method} ${path} -> HTTP ${res.status}`, {
        hint: 'Retry; if it persists the page may have moved or requires a different account.',
      });
    }
    return res;
  }

  private send(method: 'GET' | 'POST', path: string, body?: string): Promise<PortalResponse> {
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
    // so a successful Django 302 resolves to its destination.
    return this.transport.request({ method, path, headers, body, redirect: 'follow' });
  }
}

/**
 * Build a per-user client from injected credentials — the constructor seam the
 * hosted per-user deployment uses. Each call mints its own transport +
 * AuthManager, so concurrent sessions never share a cookie jar.
 */
export function createDirectClient(opts: { username?: string; password?: string }): CrownTownClient {
  const transport = new FetchTransport();
  return new CrownTownClient({ transport, auth: new AuthManager(transport, opts) });
}

/**
 * Module-level singleton for the stdio server (deferred-config-error pattern).
 *
 * This constructor must stay PURE — a module-scope singleton loads this file,
 * and the Workers runtime forbids async I/O, timers, and random-value generation
 * in global scope. `FetchTransport` only stores a timeout and `AuthManager` only
 * reads env vars, so constructing here is safe.
 */
export const client = new CrownTownClient();
