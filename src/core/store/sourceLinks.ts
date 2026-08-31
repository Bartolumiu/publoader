import type { PrismaClient } from "@prisma/client";
import { Manifest, hostAllowed } from "../../contracts/manifest.js";
import { normaliseOfficialLink } from "../md/officialLink.js";
import { idFromUrl, learnIdUrlRule, type IdUrlRule } from "../md/idFromUrl.js";
import { DEFAULT_NAMESPACE } from "./trackedManga.js";

/**
 * "Here is the publisher's page for a series" → which extension, and which of
 * its ids.
 *
 * WHY THIS EXISTS. Mapping a series took three facts, and an operator arriving
 * from a Discord message or a publisher's new-releases page has one: the URL.
 * The other two — which extension covers that site, and what that extension
 * calls the series — were looked up by hand, and the second one is the reason
 * mapping was a job for whoever already knew the catalogue: `comikey` names a
 * series with a slug, `viz` with a number, `mangaplus` with a six-digit id, and
 * none of those are guessable from the name. So the common case was "ask the
 * person who knows", and the queue grew.
 *
 * Everything here is derived from data this platform already holds. Nothing is
 * asked of the publisher, and nothing is asked of MangaDex: the answer is a
 * fact about our own records, so it is fast, free, and available to a dry run.
 *
 * FOUR ANSWERS, STRONGEST FIRST. Each is reported as `via`, because "which
 * extension is this" and "how do you know" are the same question when a wrong
 * answer maps a live series onto the wrong title:
 *
 *   queue     this exact page is a row in the untracked queue. Then we know the
 *             extension, the id, the name it was reported under, and the row
 *             itself — so mapping it also closes the row it came from.
 *   known-id  a path segment is an id this extension already has on file. The
 *             segment boundary is what makes it safe: `100001` matching inside
 *             `/titles/1000012` would be a different series.
 *   rule      the id is where this extension's OWN urls say ids go, measured
 *             off its queue rows (idFromUrl.ts). This is the one that reaches a
 *             series nothing here has ever seen.
 *   host      only the extension is known. Still worth saying: it turns "which
 *             of the eleven is this" into "type the id".
 *
 * It fails closed at every step. Two extensions claiming one host, two ids
 * matching one url, or a learned rule the extension's own history does not
 * agree on, all resolve to no answer rather than a guess — the cost of "I could
 * not tell" is one manual lookup, and the cost of a confident wrong answer is
 * chapters uploaded onto someone else's title.
 */

/** How many of an extension's queue rows are measured for its id rule. */
const RULE_SAMPLE_LIMIT = 500;

/** How the extension and id were arrived at. Ordered strongest first. */
export type ResolvedVia = "queue" | "known-id" | "rule" | "host";

export interface ResolvedSource {
  extension: string;
  /** Null when only the extension could be determined. */
  mangaId: string | null;
  /**
   * The catalogue, when the url or an existing row names one. Null means "not
   * established", which for the single-id-space extensions is also the answer.
   */
  namespace: string | null;
  via: ResolvedVia;
  /** The queue row this url is, when it is one. */
  untracked: {
    id: string;
    mangaName: string;
    mangaLanguage: string;
    state: string;
    mdMangaId: string | null;
  } | null;
  /** The mapping this series already has, when it has one. */
  tracked: { mdMangaId: string; namespace: string; source: string } | null;
  /** Set for `via: "rule"`, so an operator can weigh a measured guess. */
  rule?: IdUrlRule;
}

export interface SourceResolution {
  url: string;
  /** Host and path, as `normaliseOfficialLink` compares them. */
  normalised: string | null;
  host: string | null;
  match: ResolvedSource | null;
  /** Extensions whose `allowed_hosts` claim this host. */
  candidates: string[];
  /** The matched extension's catalogues, when it has more than the flat one. */
  namespaces: string[];
  /** Why there is no match, in words an operator can act on. */
  reason?: string;
}

export interface SourceLinkDeps {
  prisma: PrismaClient;
  /** Latest non-yanked manifest per extension; the host index is built from it. */
  manifests(): Promise<Map<string, Manifest>>;
}

/**
 * The url forms one page is written in, for an exact lookup against stored rows.
 *
 * `manga_url` is stored verbatim as the extension reported it, so a paste that
 * differs only in scheme, `www.` or a trailing slash would miss it. Comparing
 * in SQL against a handful of spellings is what keeps this an indexed equality
 * lookup rather than a scan of every row the queue holds.
 */
export function urlVariants(raw: string): string[] {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return [];
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return [];
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  const out = new Set<string>();
  for (const scheme of ["https", "http"]) {
    for (const prefix of ["", "www."]) {
      for (const tail of ["", "/"]) {
        out.add(`${scheme}://${prefix}${host}${path}${tail}${url.search}`);
      }
    }
  }
  return [...out];
}

/** Path segments, lowercased host aside, with empty ones dropped. */
function segmentsOf(raw: string): string[] {
  try {
    return new URL(raw).pathname.split("/").filter((segment) => segment !== "");
  } catch {
    return [];
  }
}

export async function resolveSourceUrl(
  deps: SourceLinkDeps,
  raw: string,
): Promise<SourceResolution> {
  const url = String(raw ?? "").trim();
  const normalised = normaliseOfficialLink(url);
  if (normalised === null) {
    return {
      url,
      normalised: null,
      host: null,
      match: null,
      candidates: [],
      namespaces: [],
      reason: "not an http(s) link to a publisher's page",
    };
  }
  const host = normalised.split("/")[0]!;

  const manifests = await deps.manifests();
  const candidates = [...manifests]
    .filter(([, manifest]) => hostAllowed(url, manifest.allowed_hosts))
    .map(([name]) => name)
    .sort();

  const base: SourceResolution = { url, normalised, host, match: null, candidates, namespaces: [] };

  // ---- strongest: this exact page is a row in the queue ----
  const variants = urlVariants(url);
  const queueRow = variants.length
    ? await deps.prisma.untrackedManga.findFirst({
        where: { mangaUrl: { in: variants } },
        // A series reported, skipped, then reported again leaves several rows
        // for one page; the newest is the one an operator would be acting on.
        orderBy: { createdAt: "desc" },
      })
    : null;
  if (queueRow) {
    return finish(deps, base, {
      extension: queueRow.extension,
      mangaId: queueRow.mangaId,
      namespace: null,
      via: "queue",
      untracked: {
        id: queueRow.id,
        mangaName: queueRow.mangaName,
        mangaLanguage: queueRow.mangaLanguage,
        state: queueRow.state,
        mdMangaId: queueRow.mdMangaId,
      },
      tracked: null,
    });
  }

  if (candidates.length === 0) {
    return {
      ...base,
      reason: `no published extension declares ${host} in its allowed_hosts`,
    };
  }

  const segments = segmentsOf(url);

  // ---- a path segment is an id one of these extensions already has ----
  if (segments.length > 0) {
    const [trackedHits, queueHits] = await Promise.all([
      deps.prisma.trackedManga.findMany({
        where: { extension: { in: candidates }, mangaId: { in: segments } },
      }),
      deps.prisma.untrackedManga.findMany({
        where: { extension: { in: candidates }, mangaId: { in: segments } },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const distinct = new Map<string, { extension: string; mangaId: string; namespace: string | null }>();
    for (const row of trackedHits) {
      distinct.set(`${row.extension} ${row.mangaId}`, {
        extension: row.extension,
        mangaId: row.mangaId,
        namespace: row.namespace,
      });
    }
    for (const row of queueHits) {
      const key = `${row.extension} ${row.mangaId}`;
      if (!distinct.has(key)) {
        distinct.set(key, { extension: row.extension, mangaId: row.mangaId, namespace: null });
      }
    }
    if (distinct.size === 1) {
      const hit = [...distinct.values()][0]!;
      const row = queueHits.find((r) => r.extension === hit.extension && r.mangaId === hit.mangaId);
      return finish(deps, base, {
        extension: hit.extension,
        mangaId: hit.mangaId,
        namespace: hit.namespace,
        via: "known-id",
        untracked: row
          ? {
              id: row.id,
              mangaName: row.mangaName,
              mangaLanguage: row.mangaLanguage,
              state: row.state,
              mdMangaId: row.mdMangaId,
            }
          : null,
        tracked: null,
      });
    }
    if (distinct.size > 1) {
      // Two extensions serving one host and both knowing an id in this path is
      // not a case to break a tie in: the operator names the extension.
      return {
        ...base,
        reason:
          `${distinct.size} series match that link (` +
          [...distinct.values()].map((d) => `${d.extension}/${d.mangaId}`).join(", ") +
          "); name the extension and id directly",
      };
    }
  }

  // ---- the id is where this extension's own urls put ids ----
  const learned: { extension: string; mangaId: string; rule: IdUrlRule }[] = [];
  for (const extension of candidates) {
    const rule = await learnRuleFor(deps, extension);
    if (!rule) continue;
    const mangaId = idFromUrl(url, rule);
    if (mangaId) learned.push({ extension, mangaId, rule });
  }
  if (learned.length === 1) {
    const hit = learned[0]!;
    return finish(deps, base, {
      extension: hit.extension,
      mangaId: hit.mangaId,
      namespace: null,
      via: "rule",
      untracked: null,
      tracked: null,
      rule: hit.rule,
    });
  }
  if (learned.length > 1) {
    return {
      ...base,
      reason:
        `${learned.map((l) => l.extension).join(" and ")} both serve ${host} and read that link ` +
        "differently; name the extension and id directly",
    };
  }

  // ---- host only ----
  if (candidates.length === 1) {
    return finish(deps, base, {
      extension: candidates[0]!,
      mangaId: null,
      namespace: null,
      via: "host",
      untracked: null,
      tracked: null,
    });
  }
  return {
    ...base,
    reason: `${candidates.join(", ")} all serve ${host}; name the extension yourself`,
  };
}

/**
 * Fill in what the resolved series already has: its mapping, and the catalogues
 * its extension uses.
 *
 * The mapping matters most. "This is comikey/kengan-omega" and "this is
 * comikey/kengan-omega, already mapped to a title" are different situations,
 * and the second one is where mapping again would silently repoint a live
 * series — so no caller should have to make a second request to find out.
 */
async function finish(
  deps: SourceLinkDeps,
  base: SourceResolution,
  match: ResolvedSource,
): Promise<SourceResolution> {
  const namespaces = [
    ...new Set(
      (
        await deps.prisma.trackedManga.findMany({
          where: { extension: match.extension },
          select: { namespace: true },
          distinct: ["namespace"],
        })
      )
        .map((row) => row.namespace)
        .filter((namespace) => namespace !== DEFAULT_NAMESPACE),
    ),
  ].sort();

  // A catalogue named in the url itself, for the extensions that have more than
  // one. viz writes `/shonenjump/…` and `/vizmanga/…`, and a mapping made into
  // the wrong one of those is a row nothing reads.
  const namespace =
    match.namespace ??
    segmentsOf(base.url)
      .map((segment) => segment.toLowerCase())
      .find((segment) => namespaces.includes(segment)) ??
    null;

  const tracked =
    match.mangaId === null
      ? null
      : await deps.prisma.trackedManga.findUnique({
          where: {
            extension_namespace_mangaId: {
              extension: match.extension,
              namespace: namespace ?? DEFAULT_NAMESPACE,
              mangaId: match.mangaId,
            },
          },
          select: { mdMangaId: true, namespace: true, source: true },
        });

  return { ...base, namespaces, match: { ...match, namespace, tracked } };
}

/**
 * The id rule for one extension, measured off its own queue rows.
 *
 * The queue is the right sample and the only one: it is the single place a
 * (series id, series url) pair is recorded together. `tracked_manga` holds ids
 * with no url, so it cannot teach this, and chapter urls are a different shape
 * from series urls, so the chapter rule cannot be borrowed.
 */
async function learnRuleFor(deps: SourceLinkDeps, extension: string): Promise<IdUrlRule | null> {
  const rows = await deps.prisma.untrackedManga.findMany({
    where: { extension },
    select: { mangaId: true, mangaUrl: true },
    orderBy: { createdAt: "desc" },
    take: RULE_SAMPLE_LIMIT,
  });
  return learnIdUrlRule(rows.map((row) => ({ id: row.mangaId, url: row.mangaUrl })));
}
