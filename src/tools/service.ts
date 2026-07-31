import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult, toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
import type { CrownTownClient } from '../client.js';
import { parseDashboard, parsePortalTime, parseSkippableServices, summarizeObservedTimes } from '../parse.js';

/** A row from POST /accounts/stops/api/. */
interface StopRow {
  RecordID: number;
  status: string;
  timestamp: string;
  address: string;
  weight: string;
  nickname: string;
  date: string;
  services: string;
}

const STOP_STATUS = ['success', 'missing', 'empty', 'inaccessible', 'unacceptable'] as const;

const SKIP_ENDPOINT = '/accounts/service-calendar/skip-service/';

// The portal publishes no guaranteed arrival window anywhere (dashboard, service
// calendar, and stops API all verified 2026-07-31) — only the marketing site's
// set-out policy. The observed window is derived from the account's own recorded
// collection times instead.
const SET_OUT_POLICY = {
  guaranteed_window: null,
  set_out_by: '6:00 AM',
  source:
    'crowntowncompost.com FAQ: "Just make sure your bin is set out at the curb by 6am on your pick-up day. We often start our routes early to beat the heat." Most customers set out the night before.',
} as const;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Split a dashboard "Service Day(s)" cell ("Friday", "Tuesday, Friday") into days. */
export function splitServiceDays(s: string): string[] {
  return s
    .split(/,|;|&|\band\b/i)
    .map((d) => d.trim())
    .filter(Boolean);
}

/** Leading weekday of a stops-API date ("Friday, Jul 31, 2026" -> "Friday"). */
function stopWeekday(date: string): string | null {
  const m = date.match(/^([A-Za-z]+),/);
  return m ? m[1] : null;
}

export function registerServiceTools(server: McpServer, client: CrownTownClient): void {
  server.registerTool(
    'crowntown_list_service_history',
    {
      title: 'List service history (pickups)',
      description:
        'List past collection stops for your account — date, status (Success/Missing/Empty/Inaccessible/Unacceptable), collection time, weight, and services rendered. Paginated and filterable by status. Read-only.',
      annotations: toolAnnotations({ title: 'List service history', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        status: z
          .enum(STOP_STATUS)
          .optional()
          .describe('Filter by outcome. Omit for all. One of: success, missing, empty, inaccessible, unacceptable.'),
        page: z.number().int().positive().default(1).describe('1-based page number.'),
        per_page: z.number().int().positive().max(100).default(20).describe('Rows per page (max 100).'),
      },
    },
    async ({ status, page, per_page }) => {
      const res = await client.datatable<StopRow>('/accounts/stops/api/', {
        page,
        perpage: per_page,
        sortField: 'date',
        sortDir: 'desc',
        query: status ? { status } : undefined,
      });
      const stops = (res.data ?? []).map((r) => ({
        id: r.RecordID,
        date: r.date,
        status: r.status,
        time: r.timestamp,
        weight: r.weight,
        services: r.services,
        address: r.address,
        nickname: r.nickname || undefined,
      }));
      return textResult({
        page: res.meta?.page,
        pages: res.meta?.pages,
        per_page: res.meta?.perpage,
        total: res.meta?.total,
        stops,
      });
    },
  );

  server.registerTool(
    'crowntown_list_upcoming_services',
    {
      title: 'List upcoming (skippable) services',
      description:
        'List upcoming scheduled collection days from the service calendar, each with the identifiers needed to skip it (rid, clid), the service date, and whether it is currently scheduled or already skipped. Read-only — use crowntown_skip_service to actually skip/unskip.',
      annotations: toolAnnotations({ title: 'List upcoming services', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {},
    },
    async () => {
      const services = parseSkippableServices(await client.fetchHtml('/accounts/service-calendar/'));
      return textResult({
        count: services.length,
        note: 'action="skip" means the day is currently scheduled (calling skip will skip it); action="unskip" means it is already skipped.',
        services,
      });
    },
  );

  server.registerTool(
    'crowntown_get_pickup_schedule',
    {
      title: 'Get pickup schedule (days + time window)',
      description:
        'Get the pickup schedule for each service address: pickup day(s), next service date, the official set-out-by time, and an observed arrival-time window (earliest/latest/typical and whether it is consistent or varies) derived from the recorded collection times in your service history. Crown Town Compost publishes no guaranteed arrival window, so the observed window is empirical. Read-only.',
      annotations: toolAnnotations({ title: 'Get pickup schedule', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        history_sample: z
          .number()
          .int()
          .positive()
          .max(100)
          .default(60)
          .describe('How many recent stops to derive the observed time window from (max 100).'),
      },
    },
    async ({ history_sample }) => {
      const dash = parseDashboard(await client.fetchHtml('/accounts/'));

      // The stops history is what the observed window comes from; the schedule
      // (days, next service) is still useful if that call fails, so degrade.
      let stops: StopRow[] = [];
      let historyFailed = false;
      try {
        const res = await client.datatable<StopRow>('/accounts/stops/api/', {
          page: 1,
          perpage: history_sample,
          sortField: 'date',
          sortDir: 'desc',
        });
        stops = res.data ?? [];
      } catch {
        historyFailed = true;
      }

      const notes: string[] = [
        'Crown Town Compost does not publish a guaranteed arrival-time window; observed_pickup_window is derived from the recorded collection times in your own service history.',
      ];
      if (historyFailed) notes.push('The service-history lookup failed, so no observed time window could be derived this time.');

      const addresses = dash.service_addresses.map(({ address, service_days }) => {
        const pickup_days = splitServiceDays(service_days);
        const mine = stops.filter((r) => norm(r.address) === norm(address));
        const times = mine.map((r) => parsePortalTime(r.timestamp)).filter((t): t is number => t !== null);
        const observed = summarizeObservedTimes(times);

        // Stops whose weekday differs from the scheduled day(s) — holiday-week
        // shifts, worth surfacing as a delay/special-handling note.
        const scheduled = new Set(pickup_days.map(norm));
        const off_schedule_days: Record<string, number> = {};
        for (const r of mine) {
          const day = stopWeekday(r.date);
          if (day && !scheduled.has(norm(day))) off_schedule_days[day] = (off_schedule_days[day] ?? 0) + 1;
        }
        if (Object.keys(off_schedule_days).length > 0) {
          const shifted = Object.entries(off_schedule_days)
            .map(([d, n]) => `${n} on ${d}`)
            .join(', ');
          notes.push(
            `${address}: ${mine.length - Object.values(off_schedule_days).reduce((a, b) => a + b, 0)} of ${mine.length} recorded stops ran on the scheduled day; the rest shifted (${shifted}) — typically holiday weeks.`,
          );
        }
        if (observed?.consistency === 'varies') {
          notes.push(
            `${address}: arrival time varies week to week (${observed.earliest}-${observed.latest} observed) — have the bin out by ${SET_OUT_POLICY.set_out_by} regardless of when the truck usually arrives.`,
          );
        }

        return {
          address,
          pickup_days,
          time_is_consistent: observed ? observed.consistency === 'consistent' : null,
          observed_pickup_window: observed,
          off_schedule_days: Object.keys(off_schedule_days).length > 0 ? off_schedule_days : undefined,
        };
      });

      return textResult({
        next_service: dash.next_service,
        addresses,
        set_out_policy: SET_OUT_POLICY,
        notes,
      });
    },
  );

  server.registerTool(
    'crowntown_skip_service',
    {
      title: 'Skip or un-skip an upcoming service',
      description:
        'Skip (or un-skip) an upcoming collection day. Pass the rid + clid from crowntown_list_upcoming_services. Without confirm:true this is a DRY RUN that returns a preview and makes no network call.',
      annotations: toolAnnotations({ title: 'Skip/un-skip a service', readOnly: false, openWorld: true }),
      inputSchema: {
        rid: z.string().regex(/^\d+$/).describe('Route id (data-rid) from crowntown_list_upcoming_services.'),
        clid: z.string().regex(/^\d+$/).describe('Client-location id (data-clid) from crowntown_list_upcoming_services.'),
        action: z
          .enum(['skip', 'unskip'])
          .default('skip')
          .describe('"skip" to skip the day, "unskip" to restore it. Match the action from the upcoming-services list.'),
        confirm: schemaConfirm,
      },
    },
    async ({ rid, clid, action, confirm }) => {
      if (confirm !== true) {
        return textResult({
          preview: true,
          action: 'skip_service',
          note: 'DRY RUN — nothing was sent. Re-run with confirm: true to perform this change.',
          wouldSend: { endpoint: SKIP_ENDPOINT, rid, clid, action },
        });
      }
      const body = new URLSearchParams({ rid, clid, action }).toString();
      const res = await client.write(SKIP_ENDPOINT, body);

      // Verify by re-reading the calendar: after a successful skip, that day's
      // button flips its action from "skip" to "unskip" (and vice-versa). A 200
      // alone is not proof the change persisted.
      const after = parseSkippableServices(await client.fetchHtml('/accounts/service-calendar/'));
      const match = after.find((s) => s.rid === rid && s.clid === clid);
      const expected = action === 'skip' ? 'unskip' : 'skip';
      const verified = match ? match.action === expected : false;
      return textResult({
        submitted: true,
        verified,
        status: res.status,
        rid,
        clid,
        requested_action: action,
        now: match ? { action: match.action, label: match.label, route_date: match.route_date } : null,
        ...(verified
          ? {}
          : {
              note: match
                ? 'The portal accepted the request but the calendar still shows the previous state — the change may not have persisted. Re-check the calendar.'
                : 'The portal accepted the request; the matching day is no longer in the upcoming list, so this server could not re-verify it. Check the calendar.',
            }),
      });
    },
  );
}

export { STOP_STATUS, type StopRow };
