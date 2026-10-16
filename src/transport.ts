// Node-fetch transport for the Crown Town Compost portal (a Django app). Pure
// server-side HTTP against the user's cookie session — no browser bridge is
// needed because the portal accepts a real username/password form login and
// is reachable server-side (no bot wall).

import { fetchBounded } from '@chrischall/mcp-utils';

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

/**
 * Largest portal response body read, in bytes. The portal's pages are tens of
 * KB; this only stops an unbounded (hostile or broken) response from being
 * buffered whole. Over it the request fails with mcp-utils'
 * `ResponseTooLargeError`.
 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// Default transport: node `fetch` carrying the caller-supplied Cookie header,
// through mcp-utils `fetchBounded` — one timer covering headers AND body, the
// caller's cancellation (ambient tool-call signal) folded in, and a byte cap.
// It does not judge the status, so a 3xx/4xx comes back as a PortalResponse
// exactly as before. (createApiClient's fetchRaw would turn a non-2xx into an
// error, which the login flow's manual 302 and login-redirect detection rely on
// reading.) The login POST passes redirect:'manual' so its 302's Set-Cookie is
// readable; reads use redirect:'follow' and detect login-redirects by the
// final URL/body. fetchBounded calls the global `fetch` itself (never a
// detached method reference), which is what workerd requires.
export class FetchTransport implements PortalTransport {
  constructor(
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly maxBytes: number = MAX_RESPONSE_BYTES,
  ) {}

  async request(req: PortalRequest): Promise<PortalResponse> {
    const url = req.path.startsWith('http') ? req.path : `${PORTAL_ORIGIN}${req.path}`;
    const { res, status, headers, body } = await fetchBounded(
      url,
      {
        method: req.method,
        ...(req.headers ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
        redirect: req.redirect ?? 'follow',
      },
      { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes, read: 'text', service: 'Crown Town Compost' },
    );
    const setCookie = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ?? '').split(/,(?=[^ ;]+=)/).map((s) => s.trim()).filter(Boolean);
    const location = headers.get('location') ?? undefined;
    return {
      status,
      body,
      url: res.url || url,
      setCookie,
      location,
      contentType: (headers.get('content-type') ?? '').toLowerCase(),
    };
  }
}
