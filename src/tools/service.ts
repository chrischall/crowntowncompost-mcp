import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult, toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
import type { CrownTownClient } from '../client.js';
import { parseSkippableServices } from '../parse.js';

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
