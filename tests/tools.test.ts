import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestHarness, parseToolResult } from './helpers.js';
import { CrownTownClient } from '../src/client.js';
import { AuthManager } from '../src/auth.js';
import type { PortalRequest, PortalResponse, PortalTransport } from '../src/transport.js';
import { registerServiceTools } from '../src/tools/service.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerSupportTools } from '../src/tools/support.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { DASHBOARD_HTML, IMPACT_HTML, UPDATE_FORM_HTML, CALENDAR_HTML, LOGIN_PAGE_HTML } from './fixtures/pages.js';

function res(partial: Partial<PortalResponse> = {}): PortalResponse {
  return { status: 200, body: '', url: 'https://portal.crowntowncompost.com/accounts/', setCookie: [], contentType: 'text/html', ...partial };
}
const json = (obj: unknown): PortalResponse => res({ body: JSON.stringify(obj), contentType: 'application/json' });

class MockTransport implements PortalTransport {
  requests: PortalRequest[] = [];
  constructor(private readonly handler: (req: PortalRequest) => PortalResponse) {}
  async request(req: PortalRequest): Promise<PortalResponse> {
    this.requests.push(req);
    if (req.path.includes('/accounts/login/')) {
      return req.method === 'GET'
        ? res({ body: LOGIN_PAGE_HTML, setCookie: ['csrftoken=CSRFCOOKIE; Path=/'] })
        : res({ status: 302, location: '/accounts/', setCookie: ['sessionid=SESSION; Path=/; HttpOnly'] });
    }
    return this.handler(req);
  }
  get writes(): PortalRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && !r.path.includes('/accounts/login/'));
  }
}

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => {
  if (harness) await harness.close();
  harness = undefined;
});

async function setup(
  handler: (req: PortalRequest) => PortalResponse,
  register: (s: Parameters<Parameters<typeof createTestHarness>[0]>[0], c: CrownTownClient) => void,
) {
  const transport = new MockTransport(handler);
  const auth = new AuthManager(transport, { username: 'u', password: 'p' });
  const client = new CrownTownClient({ transport, auth });
  harness = await createTestHarness((s) => register(s, client));
  return { harness: harness!, transport };
}

const call = async (h: NonNullable<typeof harness>, name: string, args: Record<string, unknown> = {}) =>
  parseToolResult(await h.callTool(name, args)) as Record<string, any>;

describe('crowntown_list_service_history', () => {
  const stops = {
    meta: { page: 1, pages: 4, perpage: 20, total: 61, sort: 'desc', field: 'date' },
    qs: '',
    data: [
      { RecordID: 157404, status: 'Success', timestamp: '9:34 a.m.', address: '123 Example Street', weight: '35', nickname: '', date: 'Friday, Jul 31, 2026', services: '35 x1' },
    ],
  };

  it('returns normalized stops with pagination metadata', async () => {
    const { harness: h } = await setup(() => json(stops), (s, c) => registerServiceTools(s, c));
    const out = await call(h, 'crowntown_list_service_history', {});
    expect(out.total).toBe(61);
    expect(out.stops[0]).toMatchObject({ id: 157404, status: 'Success', time: '9:34 a.m.', services: '35 x1' });
  });

  it('lower-cases nothing but passes the status filter straight through', async () => {
    const { harness: h, transport } = await setup(() => json(stops), (s, c) => registerServiceTools(s, c));
    await call(h, 'crowntown_list_service_history', { status: 'missing' });
    expect(new URLSearchParams(transport.writes[0].body!).get('query[status]')).toBe('missing');
  });

  it('rejects a capitalized status (the portal only matches lowercase)', async () => {
    const { harness: h } = await setup(() => json(stops), (s, c) => registerServiceTools(s, c));
    const out = (await h.callTool('crowntown_list_service_history', { status: 'Missing' })) as { isError?: boolean };
    expect(out.isError).toBe(true);
  });
});

describe('crowntown_list_upcoming_services', () => {
  it('lists skippable days with the ids a skip needs', async () => {
    const { harness: h } = await setup(() => res({ body: CALENDAR_HTML }), (s, c) => registerServiceTools(s, c));
    const out = await call(h, 'crowntown_list_upcoming_services');
    expect(out.count).toBe(3);
    expect(out.services[0]).toMatchObject({ rid: '2815', clid: '3360', action: 'skip' });
  });
});

describe('crowntown_get_pickup_schedule', () => {
  const stop = (over: Record<string, unknown>) => ({
    RecordID: 1, status: 'Success', timestamp: '9:34 a.m.', address: '123 Example Street',
    weight: '', nickname: '', date: 'Friday, Jul 31, 2026', services: '35 x1', ...over,
  });
  const stops = {
    meta: { page: 1, pages: 1, perpage: 60, total: 6, sort: 'desc', field: 'date' },
    qs: '',
    data: [
      stop({ RecordID: 1, timestamp: '9:34 a.m.', date: 'Friday, Jul 31, 2026' }),
      stop({ RecordID: 2, timestamp: '7:15 a.m.', date: 'Friday, Jul 24, 2026' }),
      stop({ RecordID: 3, timestamp: '2:13 p.m.', date: 'Friday, Jul 17, 2026' }),
      // Holiday shift: ran on a Saturday.
      stop({ RecordID: 4, timestamp: 'noon', date: 'Saturday, Jul 11, 2026' }),
      // A missed stop with no recorded time must not poison the window.
      stop({ RecordID: 5, timestamp: '', date: 'Friday, Jul 3, 2026', status: 'Missing' }),
      // Second address: tight, consistent times.
      stop({ RecordID: 6, timestamp: '8:00 a.m.', address: '456 Second Ave', date: 'Tuesday, Jul 28, 2026' }),
      stop({ RecordID: 7, timestamp: '8:20 a.m.', address: '456 Second Ave', date: 'Tuesday, Jul 21, 2026' }),
    ],
  };
  const handler = (req: PortalRequest) =>
    req.path.includes('/accounts/stops/api/') ? json(stops) : res({ body: DASHBOARD_HTML });

  it('combines dashboard days with an observed window per address', async () => {
    const { harness: h } = await setup(handler, (s, c) => registerServiceTools(s, c));
    const out = await call(h, 'crowntown_get_pickup_schedule');
    expect(out.next_service).toBe('Aug. 7, 2026');

    const first = out.addresses.find((a: any) => a.address === '123 Example Street');
    expect(first.pickup_days).toEqual(['Friday']);
    expect(first.time_is_consistent).toBe(false);
    expect(first.observed_pickup_window).toMatchObject({
      sample_size: 4, // the empty-timestamp missed stop is excluded
      earliest: '7:15 AM',
      latest: '2:13 PM',
      consistency: 'varies',
    });
    expect(first.off_schedule_days).toEqual({ Saturday: 1 });

    const second = out.addresses.find((a: any) => a.address === '456 Second Ave');
    expect(second.time_is_consistent).toBe(true);
    expect(second.observed_pickup_window.consistency).toBe('consistent');
    expect(second.off_schedule_days).toBeUndefined();
  });

  it('states the set-out policy and that no window is guaranteed', async () => {
    const { harness: h } = await setup(handler, (s, c) => registerServiceTools(s, c));
    const out = await call(h, 'crowntown_get_pickup_schedule');
    expect(out.set_out_policy.guaranteed_window).toBeNull();
    expect(out.set_out_policy.set_out_by).toBe('6:00 AM');
    expect(out.notes.join(' ')).toMatch(/does not publish a guaranteed arrival-time window/i);
  });

  it('still returns days and next service when the history lookup fails', async () => {
    const { harness: h } = await setup(
      (req) => (req.path.includes('/accounts/stops/api/') ? res({ status: 500, body: 'err' }) : res({ body: DASHBOARD_HTML })),
      (s, c) => registerServiceTools(s, c),
    );
    const out = await call(h, 'crowntown_get_pickup_schedule');
    expect(out.addresses[0].pickup_days).toEqual(['Friday']);
    expect(out.addresses[0].observed_pickup_window).toBeNull();
    expect(out.notes.join(' ')).toMatch(/history lookup failed/i);
  });

  it('passes the history sample size through to the stops query', async () => {
    const { harness: h, transport } = await setup(handler, (s, c) => registerServiceTools(s, c));
    await call(h, 'crowntown_get_pickup_schedule', { history_sample: 25 });
    const body = new URLSearchParams(transport.writes.find((r) => r.path.includes('/stops/api/'))!.body!);
    expect(body.get('pagination[perpage]')).toBe('25');
  });
});

describe('crowntown_skip_service', () => {
  it('makes NO network call without confirm and returns a preview', async () => {
    const { harness: h, transport } = await setup(() => res({ body: CALENDAR_HTML }), (s, c) => registerServiceTools(s, c));
    const out = await call(h, 'crowntown_skip_service', { rid: '2815', clid: '3360' });
    expect(out.preview).toBe(true);
    expect(out.wouldSend).toMatchObject({ rid: '2815', clid: '3360', action: 'skip' });
    expect(transport.requests).toHaveLength(0);
  });

  it('posts rid/clid/action and verifies by re-reading the calendar', async () => {
    // After the skip, the same day's button flips to action="unskip".
    const flipped = CALENDAR_HTML.replace(
      'data-action="skip" data-clid="3360" data-rid="2815"',
      'data-action="unskip" data-clid="3360" data-rid="2815"',
    );
    let skipped = false;
    const { harness: h, transport } = await setup((req) => {
      if (req.path.includes('skip-service')) { skipped = true; return res({ status: 200, body: 'ok' }); }
      return res({ body: skipped ? flipped : CALENDAR_HTML });
    }, (s, c) => registerServiceTools(s, c));

    const out = await call(h, 'crowntown_skip_service', { rid: '2815', clid: '3360', confirm: true });
    const body = new URLSearchParams(transport.writes.find((r) => r.path.includes('skip-service'))!.body!);
    expect(body.get('rid')).toBe('2815');
    expect(body.get('clid')).toBe('3360');
    expect(body.get('action')).toBe('skip');
    expect(out.verified).toBe(true);
    expect(out.now.action).toBe('unskip');
  });

  // A 200 is not proof: if the calendar still shows the old state, say so.
  it('reports verified:false when the calendar state did not change', async () => {
    const { harness: h } = await setup((req) =>
      req.path.includes('skip-service') ? res({ status: 200, body: 'ok' }) : res({ body: CALENDAR_HTML }),
    (s, c) => registerServiceTools(s, c));
    const out = await call(h, 'crowntown_skip_service', { rid: '2815', clid: '3360', confirm: true });
    expect(out.verified).toBe(false);
    expect(out.note).toMatch(/may not have persisted/i);
  });
});

describe('crowntown_list_invoices', () => {
  const invoices = {
    meta: { page: 1, pages: 1, perpage: 20, total: 2, sort: 'desc', field: 'date' },
    qs: '',
    data: [
      { RecordID: 1, number: 'INV-1', date: 'Jul 1, 2026', amount: '$44.00', status: 'paid', invoice_pdf: 'https://pay.example/pdf', receipt_url: 'https://pay.example/r', hosted_invoice_url: 'https://pay.example/h', is_payable: false, invoice_id: 11 },
      { RecordID: 2, number: 'INV-2', date: 'Aug 1, 2026', amount: '$44.00', status: 'open', invoice_pdf: '', receipt_url: '', hosted_invoice_url: 'https://pay.example/h2', is_payable: true, invoice_id: 12 },
    ],
  };

  it('returns invoices with their payment links', async () => {
    const { harness: h } = await setup(() => json(invoices), (s, c) => registerBillingTools(s, c));
    const out = await call(h, 'crowntown_list_invoices');
    expect(out.total).toBe(2);
    expect(out.invoices[0]).toMatchObject({ number: 'INV-1', is_payable: false });
  });

  it('filters to payable invoices when asked', async () => {
    const { harness: h } = await setup(() => json(invoices), (s, c) => registerBillingTools(s, c));
    const out = await call(h, 'crowntown_list_invoices', { payable_only: true });
    expect(out.invoices).toHaveLength(1);
    expect(out.invoices[0].number).toBe('INV-2');
  });
});

describe('crowntown_get_dashboard', () => {
  it('merges the dashboard page with the impact fragment', async () => {
    const { harness: h } = await setup((req) =>
      res({ body: req.path.includes('impact-statistics') ? IMPACT_HTML : DASHBOARD_HTML }),
    (s, c) => registerAccountTools(s, c));
    const out = await call(h, 'crowntown_get_dashboard');
    expect(out.account_status).toBe('Active');
    expect(out.subscription.renews).toBe('August 1, 2026, 1:00 a.m.');
    expect(out.environmental_impact.diverted_lbs).toBe(496);
  });

  it('still returns the dashboard when the impact fragment fails', async () => {
    const { harness: h } = await setup((req) =>
      req.path.includes('impact-statistics') ? res({ status: 500, body: 'err' }) : res({ body: DASHBOARD_HTML }),
    (s, c) => registerAccountTools(s, c));
    const out = await call(h, 'crowntown_get_dashboard');
    expect(out.account_status).toBe('Active');
    expect(out.environmental_impact).toBeNull();
  });
});

describe('crowntown_update_account', () => {
  it('requires at least one field to change', async () => {
    const { harness: h } = await setup(() => res({ body: UPDATE_FORM_HTML }), (s, c) => registerAccountTools(s, c));
    const out = await call(h, 'crowntown_update_account', {});
    expect(out.error).toMatch(/at least one field/i);
  });

  it('previews the merged result without writing', async () => {
    const { harness: h, transport } = await setup(() => res({ body: UPDATE_FORM_HTML }), (s, c) => registerAccountTools(s, c));
    const out = await call(h, 'crowntown_update_account', { phone: '555-000-1111' });
    expect(out.preview).toBe(true);
    expect(out.wouldSet).toMatchObject({ first_name: 'Test', last_name: 'User', phone: '555-000-1111' });
    expect(transport.writes).toHaveLength(0);
  });

  // Read-modify-write: untouched fields must be re-sent verbatim, and unchecked
  // checkboxes omitted exactly as the browser does.
  it('re-sends untouched fields and omits unchecked checkboxes', async () => {
    let saved = false;
    const { harness: h, transport } = await setup((req) => {
      if (req.method === 'POST') { saved = true; return res({ status: 302, location: '/accounts/update/' }); }
      return res({ body: saved ? UPDATE_FORM_HTML.replace('value="555-555-5555"', 'value="555-000-1111"') : UPDATE_FORM_HTML });
    }, (s, c) => registerAccountTools(s, c));

    const out = await call(h, 'crowntown_update_account', { phone: '555-000-1111', confirm: true });
    const body = new URLSearchParams(transport.writes[0].body!);
    expect(body.get('first_name')).toBe('Test');
    expect(body.get('last_name')).toBe('User');
    expect(body.get('phone')).toBe('555-000-1111');
    expect(body.has('send_email_reminders')).toBe(false); // was unchecked
    expect(body.get('service_notifications')).toBe('on'); // was checked
    expect(out.verified).toBe(true);
  });

  it('reports verified:false when the re-read shows the save did not stick', async () => {
    const { harness: h } = await setup((req) =>
      req.method === 'POST' ? res({ status: 302, location: '/accounts/update/' }) : res({ body: UPDATE_FORM_HTML }),
    (s, c) => registerAccountTools(s, c));
    const out = await call(h, 'crowntown_update_account', { phone: '555-000-1111', confirm: true });
    expect(out.verified).toBe(false);
    expect(out.note).toMatch(/did not fully change/i);
  });
});

describe('support write tools', () => {
  it('report_missed_pickup makes no call without confirm', async () => {
    const { harness: h, transport } = await setup(() => res({ status: 302 }), (s, c) => registerSupportTools(s, c));
    const out = await call(h, 'crowntown_report_missed_pickup', { date: 'Jul 24, 2026' });
    expect(out.preview).toBe(true);
    expect(transport.requests).toHaveLength(0);
  });

  it('report_missed_pickup posts date + comment when confirmed', async () => {
    const { harness: h, transport } = await setup(() => res({ status: 302, location: '/accounts/' }), (s, c) => registerSupportTools(s, c));
    const out = await call(h, 'crowntown_report_missed_pickup', { date: 'Jul 24, 2026', comment: 'bin was out', confirm: true });
    const body = new URLSearchParams(transport.writes[0].body!);
    expect(body.get('date')).toBe('Jul 24, 2026');
    expect(body.get('comment')).toBe('bin was out');
    // No per-report re-read exists, so the tool must not claim verification.
    expect(out.verified).toBe(false);
    expect(out.submitted).toBe(true);
  });

  it('contact_support makes no call without confirm', async () => {
    const { harness: h, transport } = await setup(() => res({ status: 302 }), (s, c) => registerSupportTools(s, c));
    const out = await call(h, 'crowntown_contact_support', { message: 'hello' });
    expect(out.preview).toBe(true);
    expect(transport.requests).toHaveLength(0);
  });

  it('contact_support posts the message when confirmed', async () => {
    const { harness: h, transport } = await setup(() => res({ status: 302, location: '/accounts/' }), (s, c) => registerSupportTools(s, c));
    await call(h, 'crowntown_contact_support', { message: 'please help', email: 'test@example.com', confirm: true });
    const body = new URLSearchParams(transport.writes[0].body!);
    expect(body.get('message')).toBe('please help');
    expect(body.get('email')).toBe('test@example.com');
  });
});

describe('crowntown_healthcheck', () => {
  it('reports authenticated with the parsed account status', async () => {
    const { harness: h } = await setup(() => res({ body: DASHBOARD_HTML }), (s, c) => registerHealthcheckTools(s, c));
    const out = await call(h, 'crowntown_healthcheck');
    expect(out).toMatchObject({ ok: true, authenticated: true, account_status: 'Active', service_addresses: 2 });
  });

  // Hermetic: AuthManager falls back to CROWNTOWN_USERNAME/PASSWORD from the
  // environment (and client.ts loads a local .env at import), so this test must
  // clear them explicitly — otherwise a developer with real creds on disk sees
  // it "pass" as authenticated while CI, with no .env, tests something else.
  it('distinguishes missing credentials from bad ones', async () => {
    vi.stubEnv('CROWNTOWN_USERNAME', '');
    vi.stubEnv('CROWNTOWN_PASSWORD', '');
    try {
      const transport = new MockTransport(() => res({ body: DASHBOARD_HTML }));
      const client = new CrownTownClient({ transport, auth: new AuthManager(transport, {}) });
      harness = await createTestHarness((s) => registerHealthcheckTools(s, client));
      const out = await call(harness, 'crowntown_healthcheck');
      expect(out.ok).toBe(false);
      expect(out.authenticated).toBe(false);
      // Both routes must be named: someone who deliberately configured a
      // session cookie is not helped by being told only about the password.
      expect(out.hint).toMatch(/CROWNTOWN_SESSION_COOKIE/);
      expect(out.hint).toMatch(/CROWNTOWN_USERNAME/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
