import { parse, type HTMLElement } from 'node-html-parser';

// Parsers for the Crown Town Compost portal's server-rendered pages. All are
// defensive: a missing field yields null/[] rather than throwing, so a markup
// tweak degrades one field instead of breaking the whole tool. Verified against
// the live DOM 2026-07-31 (see docs/CROWNTOWN-API.md).

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

export interface ServiceAddress {
  address: string;
  service_days: string;
}

export interface DashboardSummary {
  account_status: string | null;
  active_subscriptions: string | null;
  next_service: string | null;
  subscription: {
    status: string | null;
    price: string | null;
    period: string | null;
    plan: string | null;
    renews: string | null;
  };
  service_addresses: ServiceAddress[];
}

/** Read a `.account-status-item` value by its leading label. */
function statusItem(items: HTMLElement[], label: string): string | null {
  for (const it of items) {
    const t = collapse(it.textContent);
    if (t.startsWith(label)) return collapse(t.slice(label.length)) || null;
  }
  return null;
}

/** Find the card whose header/heading text contains `heading`. */
function cardByHeading(root: HTMLElement, heading: string): HTMLElement | null {
  for (const card of root.querySelectorAll('.card')) {
    const h = card.querySelector('h1,h2,h3,h4,h5,.card-title');
    if (h && collapse(h.textContent).toLowerCase().includes(heading.toLowerCase())) return card;
  }
  return null;
}

export function parseDashboard(html: string): DashboardSummary {
  const root = parse(html);
  const items = root.querySelectorAll('.account-status-item');
  const text = collapse(root.textContent);

  const priceMatch = text.match(/\$([\d,]+\.\d{2})\s*\/\s*([A-Za-z]+)/);
  // The renewal date is rendered twice for responsive layouts — a short form
  // ("August 1") followed by the full one ("August 1, 2026, 1:00 a.m."). Skip
  // ahead to the first form that actually carries a year.
  const renewsMatch = text.match(
    /Renews[\s\S]{0,40}?([A-Za-z]+\.?\s+\d{1,2},\s*\d{4}(?:,\s*\d{1,2}:\d{2}\s*[ap]\.?m\.?)?)/i,
  );
  // The plan line pairs a service name with its price, e.g. "Weekly Residential Service $44.00".
  const planMatch = text.match(/([A-Z][A-Za-z ]*?(?:Service|Plan|Subscription))\s+\$[\d,]+\.\d{2}/);

  // The subscription "Active"/"Paused" badge is the wide Metronic badge.
  const badge = root.querySelector('.m-badge--wide');

  const addrCard = cardByHeading(root, 'Service Address');
  const service_addresses: ServiceAddress[] = [];
  if (addrCard) {
    for (const tr of addrCard.querySelectorAll('tbody tr')) {
      const cells = tr.querySelectorAll('td');
      if (cells.length >= 2) {
        service_addresses.push({
          address: collapse(cells[0].textContent),
          service_days: collapse(cells[1].textContent),
        });
      }
    }
  }

  return {
    account_status: statusItem(items, 'Account Status'),
    active_subscriptions: statusItem(items, 'Active Subscriptions'),
    next_service: statusItem(items, 'Next Service'),
    subscription: {
      status: badge ? collapse(badge.textContent) : null,
      price: priceMatch ? `$${priceMatch[1]}` : null,
      period: priceMatch ? priceMatch[2].toLowerCase() : null,
      plan: planMatch ? collapse(planMatch[1]) : null,
      renews: renewsMatch ? collapse(renewsMatch[1]) : null,
    },
    service_addresses,
  };
}

export interface EnvironmentalImpact {
  diverted_lbs: number | null;
  seedlings: number | null;
  miles_offset: number | null;
  gallons_gas: number | null;
  /** The raw headline strings, e.g. "496 lbs diverted!". */
  headlines: string[];
}

/** Parse the `/accounts/impact-statistics/` htmx fragment. */
export function parseImpact(html: string): EnvironmentalImpact {
  const text = collapse(parse(html).textContent);
  const num = (re: RegExp): number | null => {
    const m = text.match(re);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  const headlines = [
    text.match(/([\d,.]+\s+lbs diverted!?)/i)?.[1],
    text.match(/([\d,.]+\s+seedlings planted!?)/i)?.[1],
    text.match(/([\d,.]+\s+miles offset!?)/i)?.[1],
    text.match(/([\d,.]+\s+gallons of gas!?)/i)?.[1],
  ].filter((x): x is string => !!x).map(collapse);
  return {
    diverted_lbs: num(/([\d,.]+)\s+lbs diverted/i),
    seedlings: num(/([\d,.]+)\s+seedlings planted/i),
    miles_offset: num(/([\d,.]+)\s+miles offset/i),
    gallons_gas: num(/([\d,.]+)\s+gallons of gas/i),
    headlines,
  };
}

export interface AccountDetails {
  first_name: string;
  last_name: string;
  phone: string;
  send_email_reminders: boolean;
  service_notifications: boolean;
}

/** Read the current values from the `/accounts/update/` form. */
export function parseAccountDetails(html: string): AccountDetails {
  const root = parse(html);
  const val = (name: string): string => root.querySelector(`[name="${name}"]`)?.getAttribute('value') ?? '';
  const checked = (name: string): boolean => {
    const el = root.querySelector(`[name="${name}"]`);
    return el?.hasAttribute('checked') ?? false;
  };
  return {
    first_name: val('first_name'),
    last_name: val('last_name'),
    phone: val('phone'),
    send_email_reminders: checked('send_email_reminders'),
    service_notifications: checked('service_notifications'),
  };
}

export interface SkippableService {
  rid: string;
  clid: string;
  /** Human date on the button, e.g. "Aug. 7, 2026". */
  route_date: string;
  /** The toggle the button performs: "skip" (currently scheduled) or "unskip" (currently skipped). */
  action: string;
  /** Button label, e.g. "Skip Service" / "Undo Skip". */
  label: string;
  skip_has_credit: boolean;
}

/** Parse the server-rendered `.submit-skip` buttons on the service calendar. */
export function parseSkippableServices(html: string): SkippableService[] {
  const root = parse(html);
  const out: SkippableService[] = [];
  for (const b of root.querySelectorAll('.submit-skip')) {
    const rid = b.getAttribute('data-rid');
    const clid = b.getAttribute('data-clid');
    if (!rid || !clid) continue;
    out.push({
      rid,
      clid,
      route_date: b.getAttribute('data-route-date') ?? '',
      action: b.getAttribute('data-action') ?? 'skip',
      label: collapse(b.textContent),
      skip_has_credit: b.getAttribute('data-skip-has-credit') === 'true',
    });
  }
  return out;
}
