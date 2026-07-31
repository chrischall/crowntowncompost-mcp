// Node-fetch transport for the Crown Town Compost portal (a Django app). Pure
// server-side HTTP against the user's cookie session — no browser bridge is
// needed because the portal accepts a real username/password form login and
// is reachable server-side (no bot wall).

export const PORTAL_ORIGIN = 'https://portal.crowntowncompost.com';

export interface PortalRequest {
  method: 'GET' | 'POST';
  /** Path-and-query relative to PORTAL_ORIGIN, or an absolute URL. */
  path: string;
  headers?: Record<string, string>;
  /** Serialized request body (form-urlencoded). Omitted for GET. */
  body?: string;
  /** 'follow' (default) for reads; 'manual' for the login POST so the 302's Set-Cookie is readable. */
  redirect?: 'follow' | 'manual';
}

export interface PortalResponse {
  status: number;
  body: string;
  /** Final URL after redirects (used to detect a redirect back to the login page). */
  url: string;
  /** Set-Cookie header lines from this response. */
  setCookie: string[];
  /** Location header (present on a manual 3xx). */
  location?: string;
  /** Lowercased content-type of the response. */
  contentType: string;
}

export interface PortalTransport {
  request(req: PortalRequest): Promise<PortalResponse>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Default transport: node `fetch` carrying the caller-supplied Cookie header.
// The login POST passes redirect:'manual' so its 302's Set-Cookie is readable;
// reads use redirect:'follow' and detect login-redirects by the final URL/body.
export class FetchTransport implements PortalTransport {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async request(req: PortalRequest): Promise<PortalResponse> {
    const url = req.path.startsWith('http') ? req.path : `${PORTAL_ORIGIN}${req.path}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: req.redirect ?? 'follow',
        signal: ac.signal,
      });
      const body = await res.text();
      const setCookie = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') ?? '').split(/,(?=[^ ;]+=)/).map((s) => s.trim()).filter(Boolean);
      const location = res.headers.get('location') ?? undefined;
      return {
        status: res.status,
        body,
        url: res.url || url,
        setCookie,
        location,
        contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
