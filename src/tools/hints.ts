/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`, the context-groups contract). Inert data: a client that
 * does not read them sees an extra `_meta` key and nothing else. The shape is
 * restated here rather than imported — this server takes no dependency on
 * mcp-host.
 *
 * Every tool here is in the `home` group. `subject` is never set: the server
 * signs in to ONE portal account and no tool takes a choice of address or
 * account, so there is nothing a person's subject could be matched against.
 * `aliases` are the words a person says — lowercase, at most 8, each at most
 * 40 chars.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'home';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for a Crown Town Compost tool. */
export function homeMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {},
): { mint: MintHint } {
  return { mint: { domain: 'home', intent, ...extra } };
}

/** What people call this service. */
export const COMPOST_ALIASES = ['compost', 'compost pickup', 'compost bin', 'food scraps'];
