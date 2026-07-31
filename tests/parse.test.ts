import { describe, it, expect } from 'vitest';
import {
  parseDashboard,
  parseImpact,
  parseAccountDetails,
  parseSkippableServices,
  parsePortalTime,
  formatClockTime,
  summarizeObservedTimes,
} from '../src/parse.js';
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

describe('parsePortalTime', () => {
  // Every format the live stops API rendered on 2026-07-31.
  it('parses each Django TIME_FORMAT the portal renders', () => {
    expect(parsePortalTime('9:34 a.m.')).toBe(9 * 60 + 34);
    expect(parsePortalTime('12:26 p.m.')).toBe(12 * 60 + 26);
    expect(parsePortalTime('2 p.m.')).toBe(14 * 60);
    expect(parsePortalTime('noon')).toBe(12 * 60);
    expect(parsePortalTime('midnight')).toBe(0);
  });

  it('handles the 12-hour edge cases', () => {
    expect(parsePortalTime('12:05 a.m.')).toBe(5);
    expect(parsePortalTime('12 p.m.')).toBe(12 * 60);
  });

  it('returns null for empty or unrecognized values', () => {
    expect(parsePortalTime('')).toBeNull();
    expect(parsePortalTime('&mdash;')).toBeNull();
    expect(parsePortalTime('25:00 a.m.')).toBeNull();
  });
});

describe('formatClockTime', () => {
  it('formats minutes since midnight on a 12-hour clock', () => {
    expect(formatClockTime(0)).toBe('12:00 AM');
    expect(formatClockTime(9 * 60 + 34)).toBe('9:34 AM');
    expect(formatClockTime(12 * 60)).toBe('12:00 PM');
    expect(formatClockTime(14 * 60 + 13)).toBe('2:13 PM');
  });
});

describe('summarizeObservedTimes', () => {
  it('returns null with no samples', () => {
    expect(summarizeObservedTimes([])).toBeNull();
  });

  it('reports a wide spread as varying, with the typical (IQR) window', () => {
    // 8:00, 9:00, 10:00, 11:00, 14:00 — spread 6h.
    const w = summarizeObservedTimes([480, 540, 600, 660, 840])!;
    expect(w.sample_size).toBe(5);
    expect(w.earliest).toBe('8:00 AM');
    expect(w.latest).toBe('2:00 PM');
    expect(w.median).toBe('10:00 AM');
    expect(w.typical_window).toBe('9:00 AM - 11:00 AM');
    expect(w.consistency).toBe('varies');
  });

  it('reports a tight spread as consistent', () => {
    const w = summarizeObservedTimes([480, 490, 500, 510])!;
    expect(w.consistency).toBe('consistent');
    expect(w.spread_minutes).toBe(30);
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
