import { describe, it, expect } from 'vitest';
import { parseDashboard, parseImpact, parseAccountDetails, parseSkippableServices } from '../src/parse.js';
import { DASHBOARD_HTML, IMPACT_HTML, UPDATE_FORM_HTML, CALENDAR_HTML } from './fixtures/pages.js';

describe('parseDashboard', () => {
  const d = parseDashboard(DASHBOARD_HTML);

  it('reads the account status items', () => {
    expect(d.account_status).toBe('Active');
    expect(d.active_subscriptions).toBe('1');
    expect(d.next_service).toBe('Aug. 7, 2026');
  });

  it('reads the subscription price, period, plan and status badge', () => {
    expect(d.subscription.price).toBe('$44.00');
    expect(d.subscription.period).toBe('month');
    expect(d.subscription.plan).toBe('Weekly Residential Service');
    expect(d.subscription.status).toBe('Active');
  });

  // Regression: the portal renders the renewal date twice for responsive layouts
  // — a short "August 1" followed by the full "August 1, 2026, 1:00 a.m.". The
  // first parser matched the short form and yielded null against the live page.
  it('reads the FULL renewal date even though a short form precedes it', () => {
    expect(d.subscription.renews).toBe('August 1, 2026, 1:00 a.m.');
  });

  it('reads every service address row with its service day', () => {
    expect(d.service_addresses).toEqual([
      { address: '123 Example Street', service_days: 'Friday' },
      { address: '456 Second Ave', service_days: 'Tuesday' },
    ]);
  });

  it('degrades to nulls/empties instead of throwing on unknown markup', () => {
    const empty = parseDashboard('<html><body><p>nothing here</p></body></html>');
    expect(empty.account_status).toBeNull();
    expect(empty.subscription.price).toBeNull();
    expect(empty.service_addresses).toEqual([]);
  });
});

describe('parseImpact', () => {
  it('extracts each environmental-impact number, including decimals', () => {
    expect(parseImpact(IMPACT_HTML)).toMatchObject({
      diverted_lbs: 496,
      seedlings: 3.3,
      miles_offset: 492,
      gallons_gas: 22,
    });
  });

  it('keeps the raw headlines', () => {
    expect(parseImpact(IMPACT_HTML).headlines).toContain('496 lbs diverted!');
  });

  it('returns nulls when the fragment is empty', () => {
    expect(parseImpact('<div></div>')).toMatchObject({ diverted_lbs: null, seedlings: null });
  });
});

describe('parseAccountDetails', () => {
  it('reads current values and checkbox states', () => {
    expect(parseAccountDetails(UPDATE_FORM_HTML)).toEqual({
      first_name: 'Test',
      last_name: 'User',
      phone: '555-555-5555',
      send_email_reminders: false,
      service_notifications: true,
    });
  });
});

describe('parseSkippableServices', () => {
  const s = parseSkippableServices(CALENDAR_HTML);

  it('returns one entry per skip button, ignoring non-skippable days', () => {
    expect(s).toHaveLength(3);
  });

  it('captures the identifiers a skip write needs', () => {
    expect(s[0]).toEqual({
      rid: '2815',
      clid: '3360',
      route_date: 'Aug. 7, 2026',
      action: 'skip',
      label: 'Skip Service',
      skip_has_credit: false,
    });
  });

  it('distinguishes an already-skipped day (action=unskip) from a scheduled one', () => {
    expect(s.map((x) => x.action)).toEqual(['skip', 'skip', 'unskip']);
    expect(s[2].label).toBe('Undo Skip');
  });

  it('parses the skip-has-credit flag as a boolean', () => {
    expect(s.map((x) => x.skip_has_credit)).toEqual([false, true, false]);
  });
});
