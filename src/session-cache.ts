import {
  createFileStatePersistence,
  resolveStateFile,
  type PersistedCookieSession,
  type SyncStatePersistence,
} from '@chrischall/mcp-utils/session';
import { readEnvVar, parseBoolEnv, CookieJar } from '@chrischall/mcp-utils';

/**
 * What actually goes on disk.
 *
 * The live session is `{ jar: CookieJar }` — a class instance with private
 * state, which cannot be JSON round-tripped. So the stored form is the jar's
 * rendered `Cookie` header, and {@link jarFromHeader} rebuilds a jar from it.
 * `CookieJar.absorb` parses `name=value` with attributes optional, so feeding
 * the header's pairs back in reproduces the jar exactly — verified rather than
 * assumed, and pinned by a test.
 */
export interface StoredPortalSession {
  cookieHeader: string;
}

/** Where the signed-in session is cached between runs. */
export function sessionCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStateFile({
    env,
    envVar: 'CROWNTOWN_SESSION_FILE',
    subdir: '.crowntowncompost-mcp',
    fileName: 'session.json',
  });
}

/** Rebuild a live jar from a stored `Cookie` header. */
export function jarFromHeader(header: string): CookieJar {
  const jar = new CookieJar();
  const pairs = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (pairs.length > 0) jar.absorb(pairs);
  return jar;
}

/** Guard the stored envelope: a non-empty cookie header, and a login time. */
function isStored(raw: unknown): raw is PersistedCookieSession<StoredPortalSession> {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as Partial<PersistedCookieSession<StoredPortalSession>>;
  if (typeof r.sessionAt !== 'number') return false;
  const s = r.session as Partial<StoredPortalSession> | undefined;
  if (s === null || typeof s !== 'object') return false;
  // An empty header is not a session — restoring one would look authenticated
  // and then fail every request until the expiry heuristic caught it.
  return typeof s.cookieHeader === 'string' && s.cookieHeader !== '';
}

/** Options for {@link createSessionCache}. */
export interface SessionCacheOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * The credentials actually in use. AuthManager accepts them via `opts` as
   * well as from the environment, and binding to the env pair when the caller
   * passed different ones would be wrong twice over: a per-user client built
   * with explicit credentials would silently never cache, and if it did it
   * would be keyed to somebody else's. Falls back to the env when omitted.
   */
  username?: string | null;
  password?: string | null;
  /**
   * A `Cookie` header supplied via CROWNTOWN_SESSION_COOKIE. It is a complete
   * configuration on its own, so it can be the thing a record is bound to when
   * there is no username/password pair.
   */
  sessionCookie?: string | null;
}

/**
 * The session cache, or `null` when it must not be used.
 *
 * Crown Town's login is a real form POST against a classic server-rendered site,
 * and a hosted child idles out after ten minutes — so most starts were
 * re-running it. Caching the jar makes those starts free; an expired cookie
 * still costs what it did, because `looksUnauthenticated` catches it on the
 * first request and the manager re-logs-in and replays.
 *
 * Bound to the credentials that minted it, so rotating either discards the
 * record. Only a salted digest is written; neither value reaches the file.
 */
export function createSessionCache(
  opts: SessionCacheOptions = {},
): SyncStatePersistence<PersistedCookieSession<StoredPortalSession>> | null {
  const env = opts.env ?? process.env;
  if (!parseBoolEnv('CROWNTOWN_SESSION_CACHE', { env, default: true })) return null;
  const username = opts.username ?? readEnvVar('CROWNTOWN_USERNAME', { env });
  const password = opts.password ?? readEnvVar('CROWNTOWN_PASSWORD', { env });
  const sessionCookie = opts.sessionCookie ?? readEnvVar('CROWNTOWN_SESSION_COOKIE', { env });

  // Bound to whatever actually configures this server. The login pair when
  // there is one; otherwise the supplied cookie, which is a complete
  // configuration on its own — so replacing it must discard a record minted
  // from the previous one.
  const boundTo =
    username && password
      ? ['login', username.trim().toLowerCase(), password].join('\u0000')
      : sessionCookie
        ? ['cookie', sessionCookie].join('\u0000')
        : null;
  if (boundTo === null) return null;

  return createFileStatePersistence<PersistedCookieSession<StoredPortalSession>>({
    filePath: sessionCachePath(env),
    // Joined on a NUL, written as an escape rather than a literal byte: a
    // password may contain spaces, so a space-joined pair could collide with a
    // different pair by shifting the boundary between the two halves.
    boundTo,
    validate: (raw) => (isStored(raw) ? raw : null),
  });
}

/**
 * Report a cache write that failed. Not fatal: the session is re-mintable from
 * the credentials in the environment, so a lost write costs the next start a
 * login rather than access. Worth saying, though — a read-only data dir
 * otherwise looks exactly like a server that never caches.
 *
 * stderr only; stdout is the JSON-RPC channel.
 */
export function reportCacheWriteFailure(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(
    `[crowntowncompost-mcp] could not cache the session (${detail}); continuing without the ` +
      'cache — every restart will log in again until this is fixed.',
  );
}
