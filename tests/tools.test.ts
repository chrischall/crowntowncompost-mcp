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
  options?: Parameters<typeof createTestHarness>[1],
) {
  const transport = new MockTransport(handler);
  const auth = new AuthManager(transport, { username: 'u', password: 'p' });
  const client = new CrownTownClient({ transport, auth });
  harness = await createTestHarness((s) => register(s, client), options);
  return { harness: harness!, transport };
}

const call = async (h: NonNullable<typeof harness>, name: string, args: Record<string, unknown> = {}) =>
  parseToolResult(await h.callTool(name, args)) as Record<string, any>;

/**
 * A harness with no elicitation handler is a client that cannot be prompted, so
 * a write runs the two-step token flow: phase 1 returns a preview + confirmToken,
 * phase 2 repeats the call with it. Returns phase 2's raw result.
 */
async function confirmedRaw(h: NonNullable<typeof harness>, name: string, args: Record<string, unknown> = {}) {
  const phase1 = await call(h, name, args);
  expect(phase1.status).toBe('confirmation-required');
  return h.callTool(name, { ...args, confirmToken: phase1.confirmToken });
}
const confirmed = async (h: NonNullable<typeof harness>, name: string, args: Record<string, unknown> = {}) =>
  parseToolResult(await confirmedRaw(h, name, args)) as Record<string, any>;

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
  it('phase 1 makes NO network call and returns a preview + confirmToken', async () => {
    const { harness: h, transport } = await setup(() => res({ body: CALENDAR_HTML }), (s, c) => registerServiceTools(s, c));
    const out = await call(h, 'crowntown_skip_service', { rid: '2815', clid: '3360' });
    expect(out.status).toBe('confirmation-required');
    expect(out.confirmToken).toEqual(expect.any(String));
    expect(out.preview.wouldSend).toMatchObject({ endpoint: '/accounts/service-calendar/skip-service/', rid: '2815', clid: '3360', action: 'skip' });
    expect(transport.requests).toHaveLength(0);
  });

  it('phase 2 with the token performs the skip exactly once', async () => {
    const { harness: h, transport } = await setup(
      (req) => (req.path.includes('skip-service') ? res({ status: 200, body: 'ok' }) : res({ body: CALENDAR_HTML })),
      (s, c) => registerServiceTools(s, c),
    );
    await confirmed(h, 'crowntown_skip_service', { rid: '2815', clid: '3360' });
    expect(transport.writes.filter((r) => r.path.includes('skip-service'))).toHaveLength(1);
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

    const out = await confirmed(h, 'crowntown_skip_service', { rid: '2815', clid: '3360' });
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
    const out = await confirmed(h, 'crowntown_skip_service', { rid: '2815', clid: '3360' });
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

describe('crowntown_get_account', () => {
  const details = { first_name: 'Test', last_name: 'User', phone: '555-555-5555', send_email_reminders: false, service_notifications: true };

  it('returns the parsed contact details and preferences', async () => {
    const { harness: h, transport } = await setup(() => res({ body: UPDATE_FORM_HTML }), (s, c) => registerAccountTools(s, c));
    const out = await call(h, 'crowntown_get_account');
    expect(out).toEqual(details);
    // Read-only: reading the form must never POST it back.
    expect(transport.writes).toHaveLength(0);
  });

  // The two rungs agree HERE, and that is a fact about this payload rather
  // than about `view`. AccountDetails is five scalars with no image or avatar
  // among them, so compact's media strip has nothing to take. The rung
  // machinery is exercised on a payload that DOES carry media in
  // tests/view.test.ts; what matters at this call site is that asking for
  // either rung still returns the record whole.
  it('returns the same record on compact and full — the payload carries no media', async () => {
    const { harness: h } = await setup(() => res({ body: UPDATE_FORM_HTML }), (s, c) => registerAccountTools(s, c));
    expect(await call(h, 'crowntown_get_account', { view: 'compact' })).toEqual(details);
    expect(await call(h, 'crowntown_get_account', { view: 'full' })).toEqual(details);
  });

  it('rejects a rung the server does not honour', async () => {
    const { harness: h } = await setup(() => res({ body: UPDATE_FORM_HTML }), (s, c) => registerAccountTools(s, c));
    const out = await h.callTool('crowntown_get_account', { view: 'raw' });
    expect(out.isError).toBe(true);
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
    expect(out.status).toBe('confirmation-required');
    expect(out.confirmToken).toEqual(expect.any(String));
    expect(out.preview.current).toMatchObject({ phone: '555-555-5555' });
    expect(out.preview.wouldSet).toMatchObject({ first_name: 'Test', last_name: 'User', phone: '555-000-1111' });
    expect(transport.writes).toHaveLength(0);
  });

  it('phase 2 with the token saves exactly once', async () => {
    const { harness: h, transport } = await setup(
      (req) => (req.method === 'POST' ? res({ status: 302, location: '/accounts/update/' }) : res({ body: UPDATE_FORM_HTML })),
      (s, c) => registerAccountTools(s, c),
    );
    await confirmed(h, 'crowntown_update_account', { phone: '555-000-1111' });
    expect(transport.writes).toHaveLength(1);
  });

  // The token binds the full form that will be re-saved, which includes the
  // values read from the portal: an edit made elsewhere between the two calls
  // means the save would no longer be what the user approved.
  it('refuses phase 2 with DRAFT_CHANGED when the account changed on the portal in between', async () => {
    let edited = false;
    const { harness: h, transport } = await setup(
      () => res({ body: edited ? UPDATE_FORM_HTML.replace('value="Test"', 'value="Other"') : UPDATE_FORM_HTML }),
      (s, c) => registerAccountTools(s, c),
    );
    const phase1 = await call(h, 'crowntown_update_account', { phone: '555-000-1111' });
    edited = true;
    const raw = await h.callTool('crowntown_update_account', { phone: '555-000-1111', confirmToken: phase1.confirmToken });
    expect(raw.isError).toBe(true);
    expect(parseToolResult(raw)).toMatchObject({ error: 'DRAFT_CHANGED' });
    expect(transport.writes).toHaveLength(0);
  });

  it('refuses before any gate when no field is given', async () => {
    const { harness: h, transport } = await setup(() => res({ body: UPDATE_FORM_HTML }), (s, c) => registerAccountTools(s, c));
    const out = await call(h, 'crowntown_update_account', {});
    expect(out.error).toMatch(/at least one field/i);
    expect(transport.requests).toHaveLength(0);
  });

  // Read-modify-write: untouched fields must be re-sent verbatim, and unchecked
  // checkboxes omitted exactly as the browser does.
  it('re-sends untouched fields and omits unchecked checkboxes', async () => {
    let saved = false;
    const { harness: h, transport } = await setup((req) => {
      if (req.method === 'POST') { saved = true; return res({ status: 302, location: '/accounts/update/' }); }
      return res({ body: saved ? UPDATE_FORM_HTML.replace('value="555-555-5555"', 'value="555-000-1111"') : UPDATE_FORM_HTML });
    }, (s, c) => registerAccountTools(s, c));

    const out = await confirmed(h, 'crowntown_update_account', { phone: '555-000-1111' });
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
    const out = await confirmed(h, 'crowntown_update_account', { phone: '555-000-1111' });
    expect(out.verified).toBe(false);
    expect(out.note).toMatch(/did not fully change/i);
  });
});

// The live forms (captured 2026-09-23): the missed-pickup `date` is a text input
// bound to a bootstrap-datepicker with format 'yyyy-mm-dd'; the support form
// pre-fills `email` and `phone` from the account, and a browser submits them.
const SUPPORT_FORM_HTML = `<form method="post">
  <input type="hidden" name="csrfmiddlewaretoken" value="T">
  <textarea name="message" class="form-control"></textarea>
  <input type="email" name="email" class="form-control" value="owner@example.com">
  <input type="text" name="phone" class="form-control" value="555-123-4567">
</form>`;
// Django's form_invalid: a 200 re-render of the same URL with the field errors.
const MISSED_PICKUP_INVALID_HTML = `<form method="post">
  <input type="text" name="date" class="form-control is-invalid" required id="id_date">
  <ul class="errorlist"><li>Enter a valid date.</li></ul>
  <textarea name="comment" class="form-control"></textarea>
</form>`;
const MISSED_PICKUP_FORM_HTML = `<form method="post">
  <input type="text" name="date" class="form-control" required id="id_date">
  <textarea name="comment" class="form-control"></textarea>
</form>`;
const PORTAL = 'https://portal.crowntowncompost.com';

describe('support write tools', () => {
  it('report_missed_pickup phase 1 makes no call and returns a preview + confirmToken', async () => {
    const { harness: h, transport } = await setup(() => res({ status: 302 }), (s, c) => registerSupportTools(s, c));
    const out = await call(h, 'crowntown_report_missed_pickup', { date: 'Jul 24, 2026' });
    expect(out.status).toBe('confirmation-required');
    expect(out.confirmToken).toEqual(expect.any(String));
    expect(out.preview.wouldSend).toEqual({ endpoint: '/accounts/report-missed-pickup/', date: '2026-07-24', comment: '' });
    expect(transport.requests).toHaveLength(0);
  });

  it('report_missed_pickup phase 2 submits exactly once', async () => {
    const { harness: h, transport } = await setup(() => res({ status: 302, location: '/accounts/' }), (s, c) => registerSupportTools(s, c));
    await confirmed(h, 'crowntown_report_missed_pickup', { date: '2026-07-24' });
    expect(transport.writes).toHaveLength(1);
  });

  it('report_missed_pickup posts an ISO date + comment without following the redirect', async () => {
    const { harness: h, transport } = await setup(() => res({ status: 302, location: '/accounts/' }), (s, c) => registerSupportTools(s, c));
    const out = await confirmed(h, 'crowntown_report_missed_pickup', { date: 'Friday, Jul 24, 2026', comment: 'bin was out' });
    const body = new URLSearchParams(transport.writes[0].body!);
    // The portal's datepicker submits yyyy-mm-dd; a human date is normalised to it.
    expect(body.get('date')).toBe('2026-07-24');
    expect(body.get('comment')).toBe('bin was out');
    // The redirect IS the success signal, so it must not be followed away.
    expect(transport.writes[0].redirect).toBe('manual');
    // No per-report re-read exists, so the tool must not claim verification.
    expect(out.verified).toBe(false);
    expect(out.submitted).toBe(true);
  });

  it('report_missed_pickup passes an ISO date through unchanged', async () => {
    const { harness: h, transport } = await setup(() => res({ status: 302, location: '/accounts/' }), (s, c) => registerSupportTools(s, c));
    await confirmed(h, 'crowntown_report_missed_pickup', { date: '2026-07-24' });
    expect(new URLSearchParams(transport.writes[0].body!).get('date')).toBe('2026-07-24');
  });

  it('report_missed_pickup rejects an unparseable date before sending anything', async () => {
    const { harness: h, transport } = await setup(() => res({ status: 302, location: '/accounts/' }), (s, c) => registerSupportTools(s, c));
    const out = (await h.callTool('crowntown_report_missed_pickup', { date: 'last week' })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/date/i);
    expect(transport.writes).toHaveLength(0);
  });

  it('report_missed_pickup surfaces Django field errors when the form re-renders (200)', async () => {
    const { harness: h } = await setup(
      () => res({ status: 200, url: `${PORTAL}/accounts/report-missed-pickup/`, body: MISSED_PICKUP_INVALID_HTML }),
      (s, c) => registerSupportTools(s, c),
    );
    const out = (await confirmedRaw(h, 'crowntown_report_missed_pickup', { date: '2026-07-24' })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/not submitted|did not accept/i);
    expect(out.content[0].text).toContain('Enter a valid date.');
  });

  it('report_missed_pickup does not claim success on a 200 with no redirect, even without error markup', async () => {
    const { harness: h } = await setup(
      () => res({ status: 200, url: `${PORTAL}/accounts/report-missed-pickup/`, body: MISSED_PICKUP_FORM_HTML }),
      (s, c) => registerSupportTools(s, c),
    );
    const out = (await confirmedRaw(h, 'crowntown_report_missed_pickup', { date: '2026-07-24' })) as { isError?: boolean };
    expect(out.isError).toBe(true);
  });

  // The support form pre-fills the reply-to email/phone from the account, so
  // the tool reads it on every call: the preview shows the real values that
  // will be sent, and a change to them between the calls is refused.
  it('contact_support phase 1 sends nothing and previews the exact message, email and phone', async () => {
    const { harness: h, transport } = await setup(() => res({ body: SUPPORT_FORM_HTML }), (s, c) => registerSupportTools(s, c));
    const out = await call(h, 'crowntown_contact_support', { message: 'hello' });
    expect(out.status).toBe('confirmation-required');
    expect(out.confirmToken).toEqual(expect.any(String));
    expect(out.preview.wouldSend).toEqual({ endpoint: '/accounts/support/', message: 'hello', email: 'owner@example.com', phone: '555-123-4567' });
    expect(transport.writes).toHaveLength(0);
  });

  it('contact_support phase 2 sends exactly once', async () => {
    const { harness: h, transport } = await setup(
      (req) => (req.method === 'POST' ? res({ status: 302, location: '/accounts/' }) : res({ body: SUPPORT_FORM_HTML })),
      (s, c) => registerSupportTools(s, c),
    );
    await confirmed(h, 'crowntown_contact_support', { message: 'hello' });
    expect(transport.writes).toHaveLength(1);
  });

  it('contact_support previews "(not set)" when the form pre-fills nothing', async () => {
    const bare = '<form><textarea name="message"></textarea><input name="email"><input name="phone" value=""></form>';
    const { harness: h } = await setup(() => res({ body: bare }), (s, c) => registerSupportTools(s, c));
    const out = await call(h, 'crowntown_contact_support', { message: 'hello' });
    expect(out.preview.wouldSend).toEqual({ endpoint: '/accounts/support/', message: 'hello', email: '(not set)', phone: '(not set)' });
  });

  it('contact_support posts the message when confirmed', async () => {
    const { harness: h, transport } = await setup(
      (req) => (req.method === 'POST' ? res({ status: 302, location: '/accounts/' }) : res({ body: SUPPORT_FORM_HTML })),
      (s, c) => registerSupportTools(s, c),
    );
    const out = await confirmed(h, 'crowntown_contact_support', { message: 'please help', email: 'test@example.com' });
    const body = new URLSearchParams(transport.writes[0].body!);
    expect(body.get('message')).toBe('please help');
    expect(body.get('email')).toBe('test@example.com');
    expect(transport.writes[0].redirect).toBe('manual');
    expect(out.submitted).toBe(true);
  });

  it('contact_support sends the form\'s pre-filled email and phone when the caller omits them', async () => {
    const { harness: h, transport } = await setup(
      (req) => (req.method === 'POST' ? res({ status: 302, location: '/accounts/' }) : res({ body: SUPPORT_FORM_HTML })),
      (s, c) => registerSupportTools(s, c),
    );
    await confirmed(h, 'crowntown_contact_support', { message: 'please help' });
    const body = new URLSearchParams(transport.writes[0].body!);
    expect(body.get('email')).toBe('owner@example.com');
    expect(body.get('phone')).toBe('555-123-4567');
  });

  it('contact_support surfaces Django field errors when the form re-renders (200)', async () => {
    const invalid = SUPPORT_FORM_HTML.replace('<textarea', '<ul class="errorlist"><li>This field is required.</li></ul><textarea');
    const { harness: h } = await setup(
      (req) => (req.method === 'POST' ? res({ status: 200, url: `${PORTAL}/accounts/support/`, body: invalid }) : res({ body: SUPPORT_FORM_HTML })),
      (s, c) => registerSupportTools(s, c),
    );
    const out = (await confirmedRaw(h, 'crowntown_contact_support', { message: 'x' })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('This field is required.');
  });
});

describe('write confirmation', () => {
  const OK = () => res({ status: 302, location: '/accounts/' });
  const register = (s: Parameters<Parameters<typeof createTestHarness>[0]>[0], c: CrownTownClient) => registerSupportTools(s, c);
  afterEach(() => { vi.unstubAllEnvs(); });

  it('refuses a replayed token with TOKEN_REUSED and does not write again', async () => {
    const { harness: h, transport } = await setup(OK, register);
    const args = { date: '2026-07-24', comment: 'bin was out' };
    const phase1 = await call(h, 'crowntown_report_missed_pickup', args);
    await h.callTool('crowntown_report_missed_pickup', { ...args, confirmToken: phase1.confirmToken });
    expect(transport.writes).toHaveLength(1);
    const replay = await h.callTool('crowntown_report_missed_pickup', { ...args, confirmToken: phase1.confirmToken });
    expect(replay.isError).toBe(true);
    expect(parseToolResult(replay)).toMatchObject({ error: 'TOKEN_REUSED' });
    expect(transport.writes).toHaveLength(1);
  });

  it('refuses a token whose arguments changed with DRAFT_CHANGED and does not write', async () => {
    const { harness: h, transport } = await setup(OK, register);
    const phase1 = await call(h, 'crowntown_report_missed_pickup', { date: '2026-07-24', comment: 'bin was out' });
    const out = await h.callTool('crowntown_report_missed_pickup', { date: '2026-07-24', comment: 'something else', confirmToken: phase1.confirmToken });
    expect(out.isError).toBe(true);
    expect(parseToolResult(out)).toMatchObject({ error: 'DRAFT_CHANGED' });
    expect(transport.writes).toHaveLength(0);
  });

  it('writes when a prompt-capable client accepts the confirmation', async () => {
    const { harness: h, transport } = await setup(OK, register, {
      elicitation: async () => ({ action: 'accept', content: { confirmed: true } }),
    });
    const out = await call(h, 'crowntown_report_missed_pickup', { date: '2026-07-24' });
    expect(out.submitted).toBe(true);
    expect(transport.writes).toHaveLength(1);
  });

  it('does not write when a prompt-capable client declines the confirmation', async () => {
    const { harness: h, transport } = await setup(OK, register, {
      elicitation: async () => ({ action: 'decline' }),
    });
    await h.callTool('crowntown_report_missed_pickup', { date: '2026-07-24' });
    expect(transport.writes).toHaveLength(0);
  });

  it('refuses the write under MCP_CONFIRM_MODE=refuse on a client that cannot prompt', async () => {
    vi.stubEnv('MCP_CONFIRM_MODE', 'refuse');
    const { harness: h, transport } = await setup(OK, register);
    const out = await h.callTool('crowntown_report_missed_pickup', { date: '2026-07-24' });
    expect(parseToolResult(out)).toMatchObject({ reason: 'confirmation-unsupported' });
    expect(transport.writes).toHaveLength(0);
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
