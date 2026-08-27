import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";

/**
 * Font resolution and text measurement for the chapter card.
 *
 * Two defects in the previous renderer both trace back to this file not
 * existing, and both reached readers on MangaDex:
 *
 *  - Cards rendered as nothing but tofu boxes, Latin included. SVG text is
 *    drawn by librsvg through fontconfig, so it draws a glyph only if some font
 *    on the host filesystem has it. When fontconfig resolved nothing, every
 *    character became a box and the card uploaded anyway. Nothing in the
 *    pipeline could tell a finished card from a grid of squares.
 *  - Text ran off the edge of the page. Widths were estimated from a Helvetica
 *    advance table covering code points 32..126, so every Cyrillic, Greek, Thai
 *    and CJK character was assumed to be 0.556 em. Cyrillic is wider than that
 *    and CJK is nearly double, so wrapping under-measured and lines overflowed.
 *
 * The fix is to measure with the real font, and to refuse to render at all when
 * a character has no font that can draw it. `assertRenderable` is the guarantee:
 * a card that would contain a box fails loudly instead of being published.
 *
 * Latin display faces are vendored under `assets/fonts` so their metrics and
 * their appearance are fixed regardless of host. They cover Latin only, so
 * everything else resolves from the Noto families the runtime image installs
 * (see docker/core/Dockerfile); those are found by scanning the system font
 * directories rather than by trusting fontconfig to have been configured.
 */

export type FontRole = "display" | "text" | "mono";

interface LoadedFace {
  /** Family name as SVG `font-family` must spell it. */
  family: string;
  file: string;
  font: fontkit.Font;
  unitsPerEm: number;
}

/** A vendored face: the file, and the family name it is known by. */
const VENDORED: { role: FontRole; family: string; file: string }[] = [
  { role: "display", family: "Space Grotesk", file: "SpaceGrotesk.ttf" },
  { role: "text", family: "DM Sans", file: "DMSans.ttf" },
  { role: "mono", family: "JetBrains Mono", file: "JetBrainsMono.ttf" },
];

/**
 * Filename fragments of the system families that cover what the vendored faces
 * do not, in the order they should be preferred. Matched case-insensitively
 * against files found in the system font directories, so the exact packaging
 * (ttf vs otf vs ttc, hinted vs unhinted) does not have to be predicted here.
 */
const SYSTEM_FALLBACKS = [
  "NotoSans-",
  "NotoSans[",
  "NotoSansCJK",
  "NotoSansJP",
  "NotoSerifCJK",
  "NotoSansThai",
  "NotoSansArabic",
  "DejaVuSans",
  "LiberationSans",
];

const SYSTEM_FONT_DIRS = [
  "/usr/share/fonts",
  "/usr/local/share/fonts",
  "/Library/Fonts",
  "/System/Library/Fonts",
];

/**
 * Fonts that must never be used as a fallback, matched against the filename.
 *
 * A last-resort font advertises a glyph for every code point in Unicode and
 * draws each one as a box, sometimes with a hint of the script inside it. That
 * is precisely the output this module exists to prevent, and because coverage
 * is tested by asking a font whether it has a glyph, leaving one in the chain
 * makes `assertRenderable` answer "yes, renderable" for every string and quietly
 * turns the guarantee off. macOS ships one by default.
 */
const NEVER_FALLBACK = ["lastresort", "adobeblank"];

/**
 * Where `assets/fonts` lives.
 *
 * Resolved by walking up from this module rather than from `process.cwd()`:
 * the worker runs from a different directory than the repo root, and the
 * compiled output sits under `dist/`, so both layouts have to find the same
 * directory.
 */
function findAssetsDir(): string | null {
  const fromEnv = process.env.PUBLOADER_FONT_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "assets", "fonts");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromCwd = resolve(process.cwd(), "assets/fonts");
  return existsSync(fromCwd) ? fromCwd : null;
}

function listFontFiles(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      found.push(...listFontFiles(path, depth + 1));
    } else if (/\.(ttf|otf|ttc|otc)$/i.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

/** fontkit returns a collection for .ttc/.otc; take the first face. */
function firstFace(loaded: fontkit.Font | fontkit.FontCollection): fontkit.Font | null {
  if ("fonts" in loaded && Array.isArray((loaded as fontkit.FontCollection).fonts)) {
    return (loaded as fontkit.FontCollection).fonts[0] ?? null;
  }
  return loaded as fontkit.Font;
}

let chainCache: LoadedFace[] | null = null;
let vendoredCache: Map<FontRole, LoadedFace> | null = null;
let configured = false;
const warned = new Set<string>();

function openFace(file: string, family?: string): LoadedFace | null {
  try {
    const face = firstFace(fontkit.openSync(file));
    if (!face) return null;
    return {
      family: family ?? face.familyName ?? "sans-serif",
      file,
      font: face,
      unitsPerEm: face.unitsPerEm || 1000,
    };
  } catch {
    return null;
  }
}

function loadVendored(): Map<FontRole, LoadedFace> {
  if (vendoredCache) return vendoredCache;
  const dir = findAssetsDir();
  const map = new Map<FontRole, LoadedFace>();
  if (dir) {
    for (const entry of VENDORED) {
      const face = openFace(join(dir, entry.file), entry.family);
      if (face) map.set(entry.role, face);
    }
  }
  vendoredCache = map;
  return map;
}

/**
 * Every face that may be used to draw a character, most preferred first.
 *
 * The vendored Latin faces lead because they define the card's look; the
 * system Noto families follow because they are the only thing that can draw
 * Japanese, Cyrillic or Thai.
 */
/**
 * The shared fallback chain.
 *
 * The mono face is deliberately NOT in it. JetBrains Mono is the only vendored
 * face carrying Cyrillic and Greek, so leaving it here made a Russian series
 * title render in monospace inside a display heading, and made it win over the
 * proportional Noto the runtime image installs. Mono is reachable only through
 * the `mono` role, which passes it explicitly.
 */
export function fontChain(): LoadedFace[] {
  if (chainCache) return chainCache;

  const chain: LoadedFace[] = [];
  const vendored = loadVendored();
  for (const role of ["display", "text"] as const) {
    const face = vendored.get(role);
    if (face) chain.push(face);
  }

  chainCache = chain;
  return chain;
}

/**
 * System font files not yet opened, most preferred first.
 *
 * Opened lazily and only while looking for a character nothing already loaded
 * can draw: a host can carry several hundred font files, and opening them all
 * to render one card would cost far more than it saves. The preferred families
 * are ordered first so a Japanese title picks Noto rather than whatever
 * happened to be scanned first, but every remaining file stays a candidate --
 * a host that has some other font covering the script should use it rather
 * than fail.
 */
let pendingFiles: string[] | null = null;

function systemCandidates(): string[] {
  if (pendingFiles) return pendingFiles;

  const all: string[] = [];
  for (const dir of SYSTEM_FONT_DIRS) all.push(...listFontFiles(dir));

  const preferred: string[] = [];
  const rest: string[] = [];
  for (const file of all) {
    const base = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
    if (NEVER_FALLBACK.some((fragment) => base.replace(/[\s_-]/g, "").includes(fragment))) continue;
    if (SYSTEM_FALLBACKS.some((fragment) => base.includes(fragment.toLowerCase()))) {
      preferred.push(file);
    } else {
      rest.push(file);
    }
  }

  pendingFiles = [...preferred, ...rest];
  return pendingFiles;
}

/** The face that will actually draw `codePoint`, or null when none can. */
export function faceFor(codePoint: number, preferred?: LoadedFace): LoadedFace | null {
  if (preferred && preferred.font.hasGlyphForCodePoint(codePoint)) return preferred;
  for (const face of fontChain()) {
    if (face.font.hasGlyphForCodePoint(codePoint)) return face;
  }

  // Nothing loaded covers it: open system faces until one does, keeping each
  // opened face in the chain so the next character checks it for free.
  const queue = systemCandidates();
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const face = openFace(file);
    if (!face) continue;
    (chainCache ?? fontChain()).push(face);
    if (face.font.hasGlyphForCodePoint(codePoint)) return face;
  }
  return null;
}

export function vendoredFace(role: FontRole): LoadedFace | null {
  return loadVendored().get(role) ?? null;
}

/**
 * Characters that no available font can draw.
 *
 * Whitespace is excluded: a space has no visible glyph to miss, and some faces
 * genuinely lack U+00A0 while rendering it as a space anyway.
 */
export function missingGlyphs(text: string): string[] {
  const missing: string[] = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (/\s/.test(char)) continue;
    if (faceFor(code) === null && !missing.includes(char)) missing.push(char);
  }
  return missing;
}

/**
 * Throw rather than draw a card containing boxes.
 *
 * Called with everything the card will print. A card is a page on a public
 * catalogue and replaces the chapter itself, so a grid of tofu is worse than no
 * card at all: the reader is left with something that looks broken and cannot
 * be distinguished from a rendering bug on their end. Failing here turns a
 * silent visual defect into a task error an operator can see and act on.
 */
export function assertRenderable(strings: (string | null | undefined)[]): void {
  const missing = new Set<string>();
  for (const value of strings) {
    if (!value) continue;
    for (const char of missingGlyphs(value)) missing.add(char);
  }
  if (missing.size === 0) return;

  const sample = [...missing].slice(0, 12).join("");
  const codes = [...missing]
    .slice(0, 12)
    .map((char) => "U+" + (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0"))
    .join(" ");
  throw new Error(
    `chapter card would contain unrenderable characters (${sample} = ${codes}); ` +
      `no installed font covers them. Install the matching Noto family in the runtime image ` +
      `(see docker/core/Dockerfile) or set PUBLOADER_FONT_DIR to a directory that has one.`,
  );
}

/**
 * Width of `text` at `size` logical units, measured from the real fonts.
 *
 * Each character is measured with the face that will draw it, so a Japanese
 * title mixed with Latin punctuation measures correctly rather than assuming
 * one width for everything. A character no font covers falls back to one em,
 * the widest plausible advance, so an un-renderable string is never
 * under-measured -- though `assertRenderable` should have rejected it first.
 */
export function measureText(text: string, size: number, preferred?: LoadedFace | null): number {
  if (!text) return 0;
  let width = 0;

  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;

    const face = faceFor(code, preferred ?? undefined);
    if (face === null) {
      width += size;
      continue;
    }

    let advance: number;
    try {
      const glyph = face.font.glyphForCodePoint(code);
      advance = glyph.advanceWidth;
    } catch {
      advance = face.unitsPerEm * 0.6;
    }
    width += (advance / face.unitsPerEm) * size;
  }
  return width;
}

/** `measureText` plus the extra space letter-spacing adds between glyphs. */
export function measureTracked(
  text: string,
  size: number,
  tracking: number,
  preferred?: LoadedFace | null,
): number {
  if (!text) return 0;
  const count = [...text].length;
  return measureText(text, size, preferred) + tracking * Math.max(0, count - 1);
}

/**
 * The `font-family` list for an SVG text element.
 *
 * Families are quoted because several contain spaces, and the chain is spelled
 * out in preference order so librsvg falls back exactly the way `measureText`
 * assumed when it measured.
 */
export function familyList(role: FontRole): string {
  const preferred = vendoredFace(role);
  const names: string[] = [];
  if (preferred) names.push(preferred.family);
  for (const face of fontChain()) {
    if (!names.includes(face.family)) names.push(face.family);
  }
  names.push(role === "mono" ? "monospace" : "sans-serif");
  return names.map((name) => (name.includes(" ") ? `'${name}'` : name)).join(", ");
}

/**
 * The `font-family` list for one specific string.
 *
 * Naming exactly the faces that `measureText` resolved for these characters is
 * what keeps drawing and measuring in agreement. The generic `familyList` can
 * omit a system fallback that has not been opened yet, and librsvg would then
 * substitute a font of its own choosing whose advances differ from the ones the
 * layout was computed with -- which is how text ends up overflowing a box that
 * was measured to fit.
 */
export function familiesForText(text: string, role: FontRole): string {
  const preferred = vendoredFace(role);
  const names: string[] = [];
  if (preferred) names.push(preferred.family);

  for (const char of text ?? "") {
    const code = char.codePointAt(0);
    if (code === undefined || /\s/.test(char)) continue;
    const face = faceFor(code, preferred ?? undefined);
    if (face && !names.includes(face.family)) names.push(face.family);
  }

  for (const face of fontChain()) {
    if (!names.includes(face.family)) names.push(face.family);
  }
  names.push(role === "mono" ? "monospace" : "sans-serif");
  return names.map((name) => (name.includes(" ") ? `'${name}'` : name)).join(", ");
}

/**
 * Point fontconfig at the vendored directory before anything renders.
 *
 * librsvg finds fonts through fontconfig, which by default reads only the
 * host's configuration -- the reason a host with no configured fonts produced
 * an entirely tofu card. Adding the vendored directory to the search path makes
 * the card's Latin faces available whatever the host looks like. The system
 * directories stay included so the Noto families remain reachable.
 *
 * fontconfig reads this at first use, and the card renderer is the only thing
 * here that draws text, so calling this before the first render is enough.
 */
export function ensureFontConfig(): void {
  if (configured) return;
  configured = true;

  const dir = findAssetsDir();
  if (!dir) {
    if (!warned.has("assets")) {
      warned.add("assets");
      // Not fatal: the system fonts may still cover everything, and
      // `assertRenderable` is what actually guarantees the output.
      console.warn("[card] vendored font directory not found; relying on system fonts only");
    }
    return;
  }

  // A caller that has already configured fontconfig deliberately wins.
  if (process.env.FONTCONFIG_FILE) return;

  // Write a real fontconfig file rather than relying on XDG conventions.
  // Adding the directory to XDG_DATA_DIRS only works if the host's default
  // config happens to include the xdg font rule, and on some platforms it does
  // not -- the vendored faces were then measured with but never drawn with,
  // silently substituting whatever the host preferred and breaking the
  // agreement between measurement and rendering that keeps text inside its box.
  const conf =
    `<?xml version="1.0"?>\n` +
    `<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n` +
    `<fontconfig>\n` +
    `  <dir>${escapeConfPath(dir)}</dir>\n` +
    SYSTEM_FONT_DIRS.filter((path) => existsSync(path))
      .map((path) => `  <dir>${escapeConfPath(path)}</dir>\n`)
      .join("") +
    `  <cachedir>${escapeConfPath(join(tmpdir(), "publoader-fontconfig"))}</cachedir>\n` +
    `</fontconfig>\n`;

  try {
    const target = join(tmpdir(), `publoader-fonts-${process.pid}.conf`);
    writeFileSync(target, conf, "utf8");
    process.env.FONTCONFIG_FILE = target;
  } catch (err) {
    if (!warned.has("conf")) {
      warned.add("conf");
      console.warn(`[card] could not write fontconfig file: ${String(err)}`);
    }
  }
}

function escapeConfPath(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
