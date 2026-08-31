/**
 * Read a MangaDex title id out of whatever an operator actually has in hand.
 *
 * WHY THIS EXISTS. Every mapping surface — the dashboard's add-mapping row and
 * repoint dialog, `padmin tracked set`, `/tracked set` in Discord, the bulk
 * paste box — used to demand a bare uuid. Nobody has a bare uuid. What an
 * operator has is the browser tab they just used to check the series is the
 * right one, which is `https://mangadex.org/title/<uuid>/some-slug`, and the
 * mapping step was "select the middle of the URL without catching the slug".
 * Getting that selection wrong does not error: a truncated uuid is rejected,
 * but a uuid from the wrong tab is a perfectly valid mapping onto someone
 * else's title, and chapters land there until a human notices.
 *
 * So the id is parsed here, once, and every surface accepts both forms. The
 * cost is one function; the alternative is five hand-rolled `.split("/")`
 * calls that disagree about trailing slashes and query strings.
 *
 * IT FAILS LOUD, NOT QUIETLY. A chapter link, a group link, or a legacy
 * numeric id are all things an operator plausibly pastes, and all of them would
 * either produce nothing or produce a wrong mapping. Each gets its own message
 * naming what was pasted and what to paste instead, because "invalid uuid" in
 * front of a URL that visibly contains a uuid is the least helpful thing this
 * could say.
 */

/** A MangaDex id, in the form MangaDex actually issues: a lowercase uuid. */
const MD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hosts a title link can legitimately carry.
 *
 * The bare domains plus any subdomain: `www.`, and the staging front ends
 * (`canary.mangadex.org`, `sandbox.mangadex.dev`) that operators testing a
 * mapping against a non-production title paste from. `api.mangadex.org/manga/…`
 * is the same id under a different host, and refusing it would be pedantry.
 */
const MD_HOSTS = ["mangadex.org", "mangadex.dev"];

/** Path prefixes that address a title. `manga` is the pre-2021 spelling. */
const TITLE_SEGMENTS = new Set(["title", "manga"]);

/**
 * What a non-title MangaDex link points at, so the message can say so.
 *
 * These are the ones worth naming: each is a uuid on mangadex.org that would
 * otherwise read as "close enough", and a chapter id in particular looks
 * exactly like a title id to anything that only checks the shape.
 */
const OTHER_SEGMENTS: Record<string, string> = {
  chapter: "a chapter",
  group: "a scanlation group",
  user: "a user",
  list: "a custom list",
  author: "an author",
  titles: "a title search",
};

export type TitleIdResult = { id: string } | { error: string };

/**
 * Characters that travel with a pasted link and are never part of one.
 *
 * `<…>` is how Discord suppresses an embed, so a link pasted out of a Discord
 * message arrives wrapped in it; the quotes and brackets come from copying out
 * of prose or JSON, and the trailing punctuation from copying out of a
 * sentence.
 */
function unwrap(value: string): string {
  let text = value.trim();
  // Repeated because `<"url">` is one paste away and stripping one layer would
  // leave the other.
  for (;;) {
    const before = text;
    text = text.replace(/^[<"'`([]+/, "").replace(/[>"'`)\]]+$/, "").replace(/[.,;]+$/, "").trim();
    if (text === before) return text;
  }
}

/** Whether `host` is MangaDex or one of its subdomains. */
function isMangaDexHost(host: string): boolean {
  const lower = host.toLowerCase();
  return MD_HOSTS.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

/**
 * The title id in `input`, or why there is not one.
 *
 * Accepts a bare uuid in any case, and a link in any of the shapes a browser
 * or an API response produces: with or without a scheme, with or without the
 * `www.`, with a slug, a query string or a fragment after the id.
 */
export function parseMdTitleId(input: unknown): TitleIdResult {
  if (typeof input !== "string") return { error: "expected a MangaDex title id or link" };
  const text = unwrap(input);
  if (text === "") return { error: "expected a MangaDex title id or link" };
  if (MD_UUID_RE.test(text)) return { id: text.toLowerCase() };

  // A scheme-less paste (`mangadex.org/title/…`) is what you get from a browser
  // that hides the scheme in its address bar, so it has to parse. Anything with
  // no dot and no slash is not a URL attempt at all and gets the id message.
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[^\s/]+\.[^\s/]+\//.test(text);
  if (!looksLikeUrl) {
    return {
      error: `${JSON.stringify(truncate(text))} is neither a MangaDex id (a uuid) nor a mangadex.org link`,
    };
  }

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { error: `${JSON.stringify(truncate(text))} is not a readable URL` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `${url.protocol} links are not MangaDex title links` };
  }
  if (!isMangaDexHost(url.hostname)) {
    return {
      error:
        `${url.hostname} is not MangaDex. Paste the mangadex.org/title/… link for the series, ` +
        "not the publisher's own page",
    };
  }

  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const kind = segments[0]?.toLowerCase() ?? "";
  const value = segments[1] ?? "";

  if (!TITLE_SEGMENTS.has(kind)) {
    const what = OTHER_SEGMENTS[kind];
    if (what) {
      return {
        error: `that link points at ${what}, not a series. Open the series page and paste its link instead`,
      };
    }
    return { error: `${url.href} is a MangaDex link, but not to a series` };
  }
  if (MD_UUID_RE.test(value)) return { id: value.toLowerCase() };
  if (/^\d+$/.test(value)) {
    return {
      error:
        `${value} is a pre-2021 numeric MangaDex id, which nothing here can use. ` +
        "Open the title on mangadex.org and paste the link it redirects to",
    };
  }
  return { error: `no series id in ${url.href}` };
}

/** The canonical page for a title, for anything that reports an id back. */
export function mdTitleUrl(id: string): string {
  return `https://mangadex.org/title/${id}`;
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
