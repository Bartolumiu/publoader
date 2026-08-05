/**
 * Parsing the repo-name list that `GITHUB_EXTENSIONS_REPOS` carries.
 *
 * Its own module because both an HTTP route (the push webhook) and a background
 * job (the series-map sync) need it, and a background job must not import a
 * Fastify route to get one string split.
 */

/** Comma- or whitespace-separated repo names, blanks dropped. */
export function parseRepoList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
