import type { ConnectorAuth } from '@chrischall/mcp-connector';
import { AuthManager } from './auth.js';
import { FetchTransport } from './transport.js';

/**
 * OAuth props stored per user by the Cloudflare connector's OAuth provider.
 *
 * Like the OFW and Artsonia connectors, we store the portal username AND
 * password. The Crown Town Compost portal is a Django app that authenticates
 * with a classic form login minting a short-lived `sessionid` cookie and hands
 * back NO long-lived refresh token — so the per-user client must be able to
 * re-run the form login whenever the session expires. These props are encrypted
 * at rest in `OAUTH_KV` by the OAuth provider.
 *
 * The index signature satisfies `createConnector`'s
 * `Props extends Record<string, unknown>` constraint.
 */
export interface CrownTownProps {
  username: string;
  password: string;
  [key: string]: unknown;
}

/**
 * `ConnectorAuth` for the Crown Town Compost remote connector: the login page
 * collects the user's own portal username/email + password, VERIFIES them by
 * running the same Django form login the stdio server uses (a serverless-safe
 * direct HTTP login — no browser, no bridge), and stores `{ username, password }`
 * as the OAuth props that `worker.ts`'s `buildClient` turns into a per-user
 * client capable of re-authenticating when its session cookie expires.
 */
export const crowntownAuth: ConnectorAuth<CrownTownProps> = {
  service: 'Crown Town Compost',
  accent: '#2E7D4F',
  privacyNote:
    'Your Crown Town Compost portal username and password are stored encrypted and used only to sign in to the ' +
    'portal on your behalf. The portal issues no long-lived token, so your password is kept in order to re-run ' +
    'the sign-in when the session cookie expires.',
  fields: [
    { name: 'username', label: 'Portal username or email' },
    { name: 'password', label: 'Portal password', type: 'password' },
  ],
  async login(fields) {
    const username = fields.username?.trim() ?? '';
    const password = fields.password ?? '';
    // Guard empty fields here. Without this, AuthManager's deferred-config error
    // ("CROWNTOWN_USERNAME and CROWNTOWN_PASSWORD environment variables are
    // required") would surface on the connector's login page — stdio wording
    // that means nothing to someone signing in through claude.ai, who has no
    // environment variables to set.
    if (!username || !password) {
      throw new Error('Enter both your Crown Town Compost portal username (or email) and your password.');
    }

    // Verify the credentials up front by running the real form login. Wrong
    // credentials throw here, and the connector renders the error on the login
    // page. The minted session is discarded — the per-user client logs in again
    // from the stored props.
    const transport = new FetchTransport();
    const auth = new AuthManager(transport, { username, password });
    try {
      await auth.ensureLogin();
    } catch (e) {
      // Keep McpToolError's `hint` — it carries the actionable half of the
      // message (e.g. "this is usually transient — retry") and is otherwise
      // dropped when re-wrapping.
      const base = e instanceof Error ? e.message : String(e);
      const hint = typeof (e as { hint?: unknown })?.hint === 'string' ? (e as { hint: string }).hint : '';
      const raw = hint ? `${base} ${hint}` : base;
      // Never let an upstream body echo the submitted password back onto the
      // login page. `truncateErrorMessage`/`redactSecrets` match secret SHAPES
      // (Bearer, JWT, sk-…) and would NOT catch a plain password, so scrub the
      // literal value we just sent. The empty needle is already excluded by the
      // guard above; ''.split('') would splice the placeholder between every
      // character.
      throw new Error(raw.split(password).join('[redacted]'));
    }
    return { username, password };
  },
};
