/**
 * Scope taxonomy for admin-audience credentials.
 *
 * The point is blast radius. Before scopes there was one root credential: if
 * the Discord bot's token leaked, the finder could revoke every worker, publish
 * a bundle, and delete operator accounts. Now each machine client carries only
 * the verbs it needs, so an exposed credential is confined to its area.
 *
 * Three principal kinds resolve to scope sets (see `auth.ts`):
 *   - root      — the env ADMIN_TOKEN break-glass credential: ["*"]
 *   - api-token — a `pa_…` row in `api_tokens`: exactly its stored scopes
 *   - session   — a dashboard login: OWNER gets ["*"], ADMIN everything but
 *                 `users:admin` (an admin cannot promote themselves)
 *
 * Convention: `<area>:read` / `<area>:write`, and write implies read for the
 * same area — a client that can trigger runs can obviously look at them, and
 * making callers list both halves invites over-granting by copy-paste.
 */

export const SCOPES = [
  "runs:read",
  "runs:write",
  "workers:read",
  "workers:write",
  "enroll:write",
  "extensions:read",
  "extensions:write",
  "bundles:read",
  "bundles:write",
  "untracked:read",
  "untracked:write",
  "settings:read",
  "settings:write",
  "users:admin",
  "audit:read",
  "stats:read",
] as const;

export type Scope = (typeof SCOPES)[number];

/** Grants everything, including scopes added in future versions. */
export const WILDCARD = "*";

const SCOPE_SET = new Set<string>(SCOPES);

export function isScope(value: string): value is Scope {
  return SCOPE_SET.has(value);
}

/**
 * Validate a requested scope list at mint time. Rejecting unknown strings here
 * is what stops a typo ("run:write") from silently producing a token that can
 * do nothing, and stops a caller from inventing a scope that a future release
 * might define as something powerful.
 */
export function parseScopes(requested: readonly string[]): {
  scopes: string[];
  invalid: string[];
} {
  const invalid = requested.filter((s) => s !== WILDCARD && !isScope(s));
  const scopes = [...new Set(requested.filter((s) => s === WILDCARD || isScope(s)))];
  return { scopes, invalid };
}

export interface Principal {
  kind: "root" | "api-token" | "session";
  /** Audit identity, e.g. `token:discord-bot` or `iam@ardax.dev`. */
  name: string;
  scopes: readonly string[];
  /** Set for api-token principals so last-used tracking can find the row. */
  tokenId?: string;
}

/**
 * Does this principal hold `required`?
 *
 * Wildcard grants everything. An exact match grants. `x:write` implies
 * `x:read`. Nothing else implies anything — in particular `users:admin` grants
 * only itself, so a token scoped for account management cannot quietly publish
 * bundles.
 */
export function hasScope(principal: Principal, required: Scope): boolean {
  for (const held of principal.scopes) {
    if (held === WILDCARD || held === required) return true;
    const [area, verb] = held.split(":");
    if (verb === "write" && required === `${area}:read`) return true;
  }
  return false;
}

/** Scope set for a dashboard session, by role. */
export function scopesForRole(role: "OWNER" | "ADMIN"): string[] {
  if (role === "OWNER") return [WILDCARD];
  // Everything an operator needs day to day, minus account administration.
  return SCOPES.filter((s) => s !== "users:admin");
}

/**
 * Suggested scope sets for the clients we ship. Documented here (and surfaced
 * by the dashboard's mint form) so the easy path is also the least-privilege
 * path.
 */
export const SCOPE_PRESETS: Record<string, Scope[]> = {
  // settings:write is deliberate: pausing the platform from chat during an
  // incident is the single most valuable thing the bot does, and /pause,
  // /resume and /removal-mode all live behind that scope.
  "discord-bot": [
    "runs:write",
    "workers:read",
    "extensions:read",
    "untracked:write",
    "settings:write",
    "stats:read",
    "audit:read",
  ],
  "ci-publisher": ["bundles:write"],
  monitoring: ["stats:read", "audit:read"],
  "worker-enroller": ["enroll:write", "workers:read"],
};
