/**
 * Comparing two records of the same publisher page.
 *
 * Its own module rather than a function on the title service, because the two
 * things that need it sit on opposite sides of that service: the auto-map pass
 * asks "does MangaDex record this series' page as some title's official link",
 * and `store/sourceLinks.ts` asks "which of our own rows is this pasted link".
 * Same comparison, and a second implementation of it would drift — the whole
 * value here is that both sides are exactly as loose as each other.
 */

/**
 * A url reduced to what two records of the same page must agree on.
 *
 * Publishers and MangaDex editors write the same page differently: with and
 * without the trailing slash, with and without `www.`, http against https. All
 * of those are the same series, and treating them as different would throw away
 * most real matches. Query strings are kept — for some sources they carry the
 * series identity — and the fragment is dropped, since it never does.
 *
 * Returns null for anything that is not an http(s) url, so a malformed link
 * never compares equal to another malformed one.
 */
export function normaliseOfficialLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  return `${host}${path}${url.search}`;
}
