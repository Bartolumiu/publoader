/**
 * Scope taxonomy for admin-audience credentials.
 *
 * The point is blast radius. Before scopes there was one root credential: if
 * the Discord bot's token leaked, the finder could revoke every worker, publish
 * a bundle, and delete operator accounts. Now each machine client carries only
 * the verbs it needs, so an exposed credential is confined to its area.
 *
 * Three principal kinds resolve to scope sets (see `auth.ts`):
 *   - root      - the env ADMIN_TOKEN break-glass credential: ["*"]
 *   - api-token, a `pa_…` row in `api_tokens`: exactly its stored scopes
 *   - session   - a dashboard login: OWNER gets ["*"], ADMIN everything but
 *                 `users:admin` (an admin cannot promote themselves)
 *
 * Convention: `<area>:read` / `<area>:write`, and write implies read for the
 * same area; a client that can trigger runs can obviously look at them, and
 * making callers list both halves invites over-granting by copy-paste.
 */

export const SCOPES = [
  "runs:read",
  "runs:write",
  // The chapter history tables: what this platform has published on MangaDex.
  // Deliberately NOT part of runs:*, which is about scraping and the queue that
  // drains from it. `chapters:write` queues an edit, a takedown or a delete
  // against a live public catalogue entry, so a credential that may trigger a
  // run does not thereby get to unpublish chapters.
  "chapters:read",
  "chapters:write",
  "workers:read",
  "workers:write",
  "enroll:write",
  "extensions:read",
  "extensions:write",
  // Series-map curation, deliberately separate from extensions:write (which can
  // pause an extension, rewrite its config and trigger clean runs).
  "tracked:read",
  // Append-only: create mappings that do not exist yet. Safe to hand out;
 // the worst case is a wrong new mapping, which is visible and reversible.
  "tracked:append",
  // Modify and delete existing mappings. Un-tracking a series silently stops
  // its uploads, so this stays with operators.
  "tracked:write",
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
 * `x:read`. Nothing else implies anything; in particular `users:admin` grants
 * only itself, so a token scoped for account management cannot quietly publish
 * bundles.
 */
export function hasScope(principal: Principal, required: Scope): boolean {
  for (const held of principal.scopes) {
    if (held === WILDCARD || held === required) return true;
    const [area, verb] = held.split(":");
    if (verb === "write" && required === `${area}:read`) return true;
    // Full write over an area subsumes appending to it.
    if (verb === "write" && required === `${area}:append`) return true;
    if (verb === "append" && required === `${area}:read`) return true;
  }
  return false;
}

export type Role = "OWNER" | "ADMIN" | "CONTRIBUTOR";

/**
 * The shipped scope baseline for each role. A deployment may override the
 * tunable ones (see `TUNABLE_ROLES`); anything it does not override keeps
 * tracking these as releases change them.
 */
export const DEFAULT_ROLE_SCOPES: Record<Role, readonly string[]> = {
  OWNER: [WILDCARD],
  // Everything needed to do the job and nothing else: see the catalogue,
  // add mappings, work the untracked queue. No runs, workers, credentials,
  // settings or bundles.
  CONTRIBUTOR: [
    "extensions:read",
    "tracked:read",
    "tracked:append",
    "untracked:read",
    "untracked:write",
    "stats:read",
  ],
  // ADMIN: everything an operator needs day to day, minus account administration.
  ADMIN: SCOPES.filter((s) => s !== "users:admin"),
};

/**
 * Which role baselines a deployment may edit.
 *
 * OWNER is not one of them, and that is a safety property rather than an
 * oversight: OWNER is the role that can edit permissions at all, so a baseline
 * edit that narrowed it could leave a deployment with nobody able to widen it
 * again. It stays the wildcard, and the account-level knobs below refuse to
 * touch owners for the same reason.
 */
export const TUNABLE_ROLES: readonly Role[] = ["ADMIN", "CONTRIBUTOR"];

export function isTunableRole(value: string): value is "ADMIN" | "CONTRIBUTOR" {
  return (TUNABLE_ROLES as readonly string[]).includes(value);
}

/** Scope set for a dashboard session, by role. Shipped defaults only. */
export function scopesForRole(role: Role): string[] {
  return [...DEFAULT_ROLE_SCOPES[role]];
}

/**
 * Materialise a held scope list into the exact set it grants: the wildcard
 * becomes every known scope, and `x:write`/`x:append` bring their implied
 * `x:read` along.
 *
 * This is what makes denial meaningful. Denying `runs:read` while the list
 * still holds `runs:write` would otherwise change nothing, because `hasScope`
 * would re-derive the read from the write — so a denial has to be subtracted
 * from the expanded set, not from the shorthand.
 */
export function expandScopes(held: readonly string[]): string[] {
  const out = new Set<string>();
  for (const scope of held) {
    if (scope === WILDCARD) {
      for (const s of SCOPES) out.add(s);
      continue;
    }
    if (!isScope(scope)) continue;
    out.add(scope);
    const [area, verb] = scope.split(":");
    if (verb === "write" || verb === "append") {
      const read = `${area}:read`;
      if (isScope(read)) out.add(read);
    }
    if (verb === "write") {
      const append = `${area}:append`;
      if (isScope(append)) out.add(append);
    }
  }
  return [...out];
}

/**
 * Everything a denial has to take away, given the scopes it names.
 *
 * Denial closes *upward*, the opposite direction to a grant. Refusing
 * `runs:read` has to refuse `runs:write` too, because `runs:write` implies the
 * read and would otherwise hand it straight back — "you may not look at runs,
 * but you may still start one" is not a state anybody meant to configure.
 *
 * It does not close downward: refusing `runs:write` leaves `runs:read` alone,
 * because "they can watch but not touch" is the single most useful thing this
 * feature does and expanding downward would make it inexpressible.
 */
export function denialClosure(denied: readonly string[]): string[] {
  const out = new Set<string>();
  for (const scope of denied) {
    if (scope === WILDCARD) {
      for (const s of SCOPES) out.add(s);
      continue;
    }
    if (!isScope(scope)) continue;
    out.add(scope);
    const [area, verb] = scope.split(":");
    // Anything that would imply the refused scope goes with it.
    if (verb === "read") {
      for (const implier of [`${area}:append`, `${area}:write`]) {
        if (isScope(implier)) out.add(implier);
      }
    }
    if (verb === "append") {
      const write = `${area}:write`;
      if (isScope(write)) out.add(write);
    }
  }
  return [...out];
}

/**
 * The scope set an account actually holds: its role baseline, widened by the
 * scopes granted to it individually, then narrowed by the ones denied to it.
 *
 * Denial is applied last and wins outright. "An ADMIN, except they must not
 * publish bundles" is the case this exists for, and it has to be expressible
 * without minting a fourth role for one person.
 *
 * With nothing denied the wildcard survives untouched, so an OWNER keeps
 * holding scopes that future releases add. The moment anything is denied the
 * set is materialised (see `expandScopes`) and becomes a fixed list — the only
 * honest reading of "everything except X".
 */
export function effectiveScopes(
  baseline: readonly string[],
  extra: readonly string[] = [],
  denied: readonly string[] = [],
): string[] {
  const granted = [...baseline, ...extra];
  if (denied.length === 0) {
    return [...new Set(granted)];
  }
  const refused = new Set(denialClosure(denied));
  return expandScopes(granted).filter((s) => !refused.has(s));
}

/**
 * One line per scope, for the permission editors. The dashboard renders a
 * checkbox per scope, and a checkbox labelled `tracked:append` alone asks the
 * operator to already know the answer they came to look up.
 */
export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  "runs:read": "See scrape runs, their jobs and their results.",
  "runs:write": "Trigger, retry and cancel runs.",
  "chapters:read": "See what this platform has published on MangaDex.",
  "chapters:write": "Queue edits, takedowns and deletes against live catalogue entries.",
  "workers:read": "See enrolled workers and their health.",
  "workers:write": "Pause, resume and revoke workers.",
  "enroll:write": "Enrol a new worker and mint its token.",
  "extensions:read": "See extensions and their configuration.",
  "extensions:write": "Pause extensions, rewrite their config, trigger clean runs.",
  "tracked:read": "See the series map.",
  "tracked:append": "Add series mappings that do not exist yet. Reversible, and safe to delegate.",
  "tracked:write": "Change and remove existing mappings. Un-tracking silently stops uploads.",
  "bundles:read": "See published extension bundles.",
  "bundles:write": "Publish a bundle — code execution on every worker.",
  "untracked:read": "See the untracked-series queue.",
  "untracked:write": "Triage the untracked queue.",
  "settings:read": "See platform settings.",
  "settings:write": "Change settings, including pausing and resuming the platform.",
  "users:admin": "Administer accounts, roles, permissions and client tokens.",
  "audit:read": "Read the audit log.",
  "stats:read": "Read dashboard statistics.",
};

/**
 * Suggested scope sets for the clients we ship. Documented here (and surfaced
 * by the dashboard's mint form) so the easy path is also the least-privilege
 * path.
 */
export const SCOPE_PRESETS: Record<string, Scope[]> = {
  // settings:write is deliberate: pausing the platform from chat during an
  // incident is the single most valuable thing the bot does, and /pause,
  // /resume and /removal-mode all live behind that scope.
  // `tracked:read` and `tracked:append` because the bot has had /tracked list
  // and /tracked set since it shipped, and this preset did not carry the scopes
  // either of them needs: a token minted from it answered 403 to both. Append
  // and not `tracked:write`, per the split below — a bot token that can add a
  // mapping is a convenience, one that can silently repoint a live series is a
  // different decision, and stays one an operator makes by hand.
  "discord-bot": [
    "runs:write",
    "workers:read",
    "extensions:read",
    "tracked:read",
    "tracked:append",
    "untracked:write",
    "settings:write",
    "stats:read",
    "audit:read",
  ],
  "ci-publisher": ["bundles:write"],
  monitoring: ["stats:read", "audit:read"],
  "worker-enroller": ["enroll:write", "workers:read"],
  // For a bot or script that only curates the series map.
  curator: ["extensions:read", "tracked:append", "untracked:read", "untracked:write"],
};
