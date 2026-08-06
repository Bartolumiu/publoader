/**
 * Serving the repository's own documentation to the dashboard.
 *
 * This is a file-serving endpoint reachable from the internet, so the primary
 * risk is not a bug in the markdown renderer; it is path traversal. The rules
 * here are therefore deliberately narrow and layered, in this order:
 *
 *   1. the requested name must match DOC_NAME_RE, which cannot express a
 *      separator, a leading dot, or `..`;
 *   2. it must appear in the directory listing, which is the allowlist; a name
 *      that passes the regex but is not a document we shipped is a 404;
 *   3. the resolved absolute path must still be inside the docs directory,
 *      which catches anything the first two rules failed to anticipate
 *      (a symlinked entry, a platform-specific path quirk).
 *
 * Any one of those would probably do. All three are here because the cost is a
 * few lines and the failure mode is reading arbitrary files out of the
 * container; including the prisma schema, the compiled source, and anything an
 * operator later bind-mounts nearby.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A document name. Lowercase or mixed-case word characters, dots, dashes and
 * underscores, ending in `.md`, and never starting with a dot; so `..`,
 * `../x.md`, `/etc/passwd` and `.env` are all unrepresentable rather than
 * checked for.
 */
export const DOC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/;

/** Ceiling on a single document. Ours are tens of KB; this is generous. */
export const MAX_DOC_BYTES = 2 * 1024 * 1024;

export interface DocSummary {
  name: string;
  /** First `# ` heading, falling back to the filename. */
  title: string;
  bytes: number;
  modified: Date;
}

export interface Doc extends DocSummary {
  markdown: string;
}

/**
 * Locate the shipped docs directory.
 *
 * An explicit DOCS_PATH wins. Otherwise this walks up from the compiled module
 * looking for a `docs/` directory containing at least one `.md`, which is the
 * one lookup that is correct in every layout we run in: `src/` under vitest and
 * tsx (finds the repo's docs/), and `dist/` in the container (finds /app/docs,
 * put there by the Dockerfile). Returns null when the docs were not shipped,
 * which callers must report as "not available" rather than "no documents".
 *
 * The "contains at least one .md" condition matters: an empty `docs/` is what a
 * build produces when the docs were not passed in as a build context, and
 * treating that as success would silently serve an empty list.
 */
export function resolveDocsDir(explicit = ""): string | null {
  if (explicit) return hasMarkdown(explicit) ? resolve(explicit) : null;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 8; hop++) {
    const candidate = join(dir, "docs");
    if (hasMarkdown(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function hasMarkdown(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    return readdirSync(dir).some((name) => DOC_NAME_RE.test(name));
  } catch {
    return false;
  }
}

/**
 * Every document in `dir`, alphabetically. Read fresh on each call rather than
 * cached at boot: the directory can be a bind mount in development, and a stale
 * list is a worse trade than one readdir per request on an operator-only route.
 */
export function listDocs(dir: string): DocSummary[] {
  const out: DocSummary[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !DOC_NAME_RE.test(entry.name)) continue;
    const full = join(dir, entry.name);
    const stat = statSync(full);
    out.push({
      name: entry.name,
      // Reading the whole file for its title is fine at this size and beats a
      // partial read that could split a multi-byte character mid-heading.
      title: stat.size <= MAX_DOC_BYTES ? titleOf(readFileSync(full, "utf8"), entry.name) : entry.name,
      bytes: stat.size,
      modified: stat.mtime,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One document, or null when `name` is not one we serve. Null covers every
 * rejection, a bad name, an unknown name, a path that escaped, because the
 * caller answers 404 for all of them: distinguishing "malformed" from "not
 * found" here would confirm which files exist to whoever is probing.
 */
export function readDoc(dir: string, name: string): Doc | null {
  if (!DOC_NAME_RE.test(name)) return null;
  const allowed = new Set(listDocs(dir).map((doc) => doc.name));
  if (!allowed.has(name)) return null;

  const root = resolve(dir);
  const full = resolve(root, name);
  if (!full.startsWith(root + sep)) return null;
  if (!existsSync(full)) return null;

  const stat = statSync(full);
  if (!stat.isFile() || stat.size > MAX_DOC_BYTES) return null;
  const markdown = readFileSync(full, "utf8");
  return {
    name,
    title: titleOf(markdown, name),
    bytes: stat.size,
    modified: stat.mtime,
    markdown,
  };
}

/** First ATX heading, or the filename when a document has none. */
function titleOf(markdown: string, fallback: string): string {
  const match = /^#[ \t]+(.+?)[ \t]*$/m.exec(markdown);
  return match?.[1]?.trim() || fallback;
}
