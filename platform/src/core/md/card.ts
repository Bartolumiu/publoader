import sharp from "sharp";

/**
 * Per-chapter info card, uploaded to MangaDex as the visible page when a
 * publisher takes an external chapter down. Port of publoader/chapter_image.py:
 * the same 1000x1000 logical layout rendered at 2x (a 2000x2000 PNG) — orange
 * hairline, "EXTERNAL CHAPTER" eyebrow, publisher pill, series title with an
 * accent bar, chapter number/title, source URL pill, and a footer carrying the
 * language, availability window and the removal note.
 *
 * Pillow drew this imperatively; here the same geometry is emitted as an SVG
 * and rasterised by sharp. Because SVG has no text metrics we can query, line
 * breaking uses a Helvetica advance-width table (see `advance`) — good enough
 * for wrapping decisions and, crucially, identical on every host.
 *
 * Output is a pure function of the options: no timestamps, no randomness. It is
 * byte-identical across runs on a given image, given the same installed fonts —
 * the one environmental input, which is why the family list below is pinned to
 * fonts the core image ships rather than a bare `sans-serif`.
 */

const LOGICAL = 1000;
const SCALE = 2;

const SANS = "DejaVu Sans, Liberation Sans, Helvetica, Arial, sans-serif";
const MONO = "DejaVu Sans Mono, Liberation Mono, Menlo, Consolas, monospace";

const ORANGE = "#FF6740";
const ORANGE_SOFT = "#FFF1EC";
const INK = "#17171B";
const INK_SOFT = "#5B5B63";
const INK_FAINT = "#9A9AA2";
const LINE = "#ECECEF";
const GHOST = "#F6F6F8";
const PAPER = "#FFFFFF";

const PAD_L = 88;
const PAD_R = 88;
const PAD_T = 92;
const PAD_B = 78;
const CONTENT_L = PAD_L;
const CONTENT_R = LOGICAL - PAD_R;
const CONTENT_W = CONTENT_R - CONTENT_L;

/** ISO-639-1 subset so the footer reads "English" rather than "en". */
const LANG_NAMES: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  "zh-hk": "Chinese (Traditional)",
  es: "Spanish",
  "es-la": "Spanish (LATAM)",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  "pt-br": "Portuguese (Brazil)",
  ru: "Russian",
  it: "Italian",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
  ar: "Arabic",
  pl: "Polish",
  tr: "Turkish",
  uk: "Ukrainian",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Helvetica advance widths in 1/1000 em, indexed by code point 32..126. */
const WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

export interface ChapterCardOptions {
  mangaName: string;
  chapterNumber: string | null;
  chapterTitle: string | null;
  extensionName: string;
  chapterLanguage?: string | null;
  chapterUrl?: string | null;
  availableFrom?: string | Date | null;
  availableTo?: string | Date | null;
  footerNote?: string | null;
}

/** Approximate rendered width of `text` in logical units. */
function advance(text: string, fontSize: number, bold = false): number {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 32;
    if (code >= 32 && code <= 126) {
      units += WIDTHS[code - 32] ?? 556;
    } else if (code >= 0x1100 && code <= 0x9fff) {
      units += 1000; // CJK and friends are full-width
    } else if (code >= 0xff00 && code <= 0xffef) {
      units += 1000;
    } else {
      units += 556;
    }
  }
  return (units / 1000) * fontSize * (bold ? 1.06 : 1);
}

function trackedWidth(text: string, fontSize: number, tracking: number, bold = false): number {
  if (!text) return 0;
  return advance(text, fontSize, bold) + tracking * (text.length - 1);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Greedy word wrap, ellipsising only when the text genuinely overflows. */
function wrapWords(text: string, fontSize: number, maxW: number, maxLines: number, bold = false): string[] {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let index = 0;

  while (index < words.length) {
    const word = words[index] ?? "";
    const trial = current ? `${current} ${word}` : word;
    if (advance(trial, fontSize, bold) <= maxW || !current) {
      current = trial;
      index += 1;
    } else {
      lines.push(current);
      current = "";
      if (lines.length === maxLines) break;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
    index = words.length;
  }

  if (index < words.length && lines.length > 0) {
    let last = lines[lines.length - 1] ?? "";
    while (last && advance(`${last}…`, fontSize, bold) > maxW) last = last.slice(0, -1);
    lines[lines.length - 1] = last ? `${last}…` : "…";
  }
  return lines.length > 0 ? lines : [""];
}

/** Character-level wrap for URLs, mirroring CSS `word-break: break-all`. */
function wrapChars(text: string, fontSize: number, maxW: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const char of text || "") {
    if (advance(current + char, fontSize) <= maxW || !current) {
      current += char;
    } else {
      lines.push(current);
      current = char;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let tail = lines[maxLines - 1] ?? "";
    while (tail && advance(`${tail}…`, fontSize) > maxW) tail = tail.slice(0, -1);
    lines[maxLines - 1] = `${tail}…`;
  }
  return lines.length > 0 ? lines : [""];
}

/** Format a footer date, dropping the 1990 "unknown" sentinel as Python does. */
function formatDate(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : null;
  if (date.getUTCFullYear() <= 1990) return null;
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${day} ${MONTHS[date.getUTCMonth()] ?? "Jan"} ${date.getUTCFullYear()}`;
}

interface TextOptions {
  size: number;
  fill: string;
  bold?: boolean;
  weight?: number;
  tracking?: number;
  mono?: boolean;
  anchor?: "start" | "end";
}

/** SVG `y` is a baseline; callers position by cap-top, so shift by the ascent. */
function baselineFromTop(top: number, size: number): number {
  return top + size * 0.8;
}

function baselineFromMiddle(middle: number, size: number): number {
  return middle + size * 0.35;
}

function text(x: number, baseline: number, content: string, opts: TextOptions): string {
  const weight = opts.weight ?? (opts.bold ? 700 : 400);
  const family = opts.mono ? MONO : SANS;
  const attrs = [
    `x="${round(x)}"`,
    `y="${round(baseline)}"`,
    `font-family="${family}"`,
    `font-size="${round(opts.size)}"`,
    `font-weight="${weight}"`,
    `fill="${opts.fill}"`,
  ];
  if (opts.tracking) attrs.push(`letter-spacing="${round(opts.tracking)}"`);
  if (opts.anchor === "end") attrs.push(`text-anchor="end"`);
  attrs.push(`xml:space="preserve"`);
  return `<text ${attrs.join(" ")}>${escapeXml(content)}</text>`;
}

function rect(x: number, y: number, w: number, h: number, fill: string, radius = 0): string {
  const r = radius > 0 ? ` rx="${round(radius)}" ry="${round(radius)}"` : "";
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" fill="${fill}"${r}/>`;
}

function strokedRect(x: number, y: number, w: number, h: number, stroke: string, radius: number): string {
  return (
    `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" ` +
    `rx="${round(radius)}" ry="${round(radius)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildChapterCardSvg(opts: ChapterCardOptions): string {
  const parts: string[] = [rect(0, 0, LOGICAL, LOGICAL, PAPER)];

  // ---- ghost chapter number behind the top-right corner ----
  const digits = opts.chapterNumber ? /\d+(?:\.\d+)?/.exec(String(opts.chapterNumber))?.[0] : null;
  if (digits) {
    parts.push(
      text(LOGICAL + 34, baselineFromTop(8, 300), digits, {
        size: 300,
        fill: GHOST,
        weight: 700,
        anchor: "end",
      }),
    );
  }

  // ---- orange hairline ----
  parts.push(rect(0, 0, LOGICAL, 8, ORANGE));

  // ---- header: eyebrow left, publisher pill right ----
  const eyebrowSize = 19;
  const eyebrowTracking = 0.22 * eyebrowSize;
  const dotD = 13;
  const blockMid = PAD_T + 13;
  parts.push(
    `<circle cx="${round(CONTENT_L + dotD / 2)}" cy="${round(blockMid)}" r="${round(dotD / 2)}" fill="${ORANGE}"/>`,
  );
  parts.push(
    text(CONTENT_L + dotD + 14, baselineFromMiddle(blockMid, eyebrowSize), "EXTERNAL CHAPTER", {
      size: eyebrowSize,
      fill: INK,
      weight: 600,
      tracking: eyebrowTracking,
    }),
  );

  let publisher = (opts.extensionName || "Unknown").trim();
  const pubValueSize = 19;
  const pubLabelSize = 12;
  const pubLabelTracking = 0.18 * pubLabelSize;
  while (publisher && advance(publisher, pubValueSize, true) > 240) publisher = publisher.slice(0, -1);
  const labelW = trackedWidth("PUBLISHER", pubLabelSize, pubLabelTracking, true);
  const valueW = advance(publisher, pubValueSize, true);
  const pillGap = 11;
  const pillPadX = 22;
  const pillPadY = 11;
  const pillW = labelW + pillGap + valueW + pillPadX * 2;
  const pillH = pubValueSize + pillPadY * 2;
  const pillX0 = CONTENT_R - pillW;
  const pillY0 = blockMid - pillH / 2;
  parts.push(strokedRect(pillX0, pillY0, pillW, pillH, LINE, pillH / 2));
  parts.push(
    text(pillX0 + pillPadX, baselineFromMiddle(blockMid, pubLabelSize), "PUBLISHER", {
      size: pubLabelSize,
      fill: INK_FAINT,
      weight: 600,
      tracking: pubLabelTracking,
    }),
  );
  parts.push(
    text(pillX0 + pillPadX + labelW + pillGap, baselineFromMiddle(blockMid, pubValueSize), publisher, {
      size: pubValueSize,
      fill: INK,
      weight: 600,
    }),
  );
  const headerBottom = pillY0 + pillH;

  // ---- footer measured first, so the body can be centred in what's left ----
  const keySize = 14;
  const valueSize = 21;
  const noteSize = 18;
  const keyTracking = 0.16 * keySize;

  const langCode = opts.chapterLanguage ?? null;
  const langDisplay = langCode ? (LANG_NAMES[langCode.toLowerCase()] ?? langCode) : null;
  const dateFrom = formatDate(opts.availableFrom);
  const dateTo = formatDate(opts.availableTo);
  // A removal date under an "Available" label with no start date reads as
  // misinformation, so the window only appears when we know when it began.
  const showWindow = Boolean(dateFrom);

  const noteText =
    opts.footerNote ??
    (showWindow
      ? "This chapter was officially available on the publisher's site during the dates above. " +
        "It has since been removed and is no longer available on the publisher."
      : "This chapter was officially available on the publisher's site. " +
        "It has since been removed and is no longer available on the publisher.");
  const noteLines = wrapWords(noteText, noteSize, 760, 4);

  const rowH = 28;
  const rowGap = 14;
  const noteAdvance = noteSize * 1.45;
  const rows: ("language" | "available")[] = [];
  if (langDisplay) rows.push("language");
  if (showWindow) rows.push("available");

  let footerH = 30 + rows.length * (rowH + rowGap) + noteAdvance * noteLines.length;
  // Room for the publoader mark under the note.
  footerH += 26;
  const footTop = LOGICAL - PAD_B - footerH;

  // ---- body ----
  const titleSize = 78;
  const chTitleSize = 44;
  const urlSize = 21;
  const titleX = CONTENT_L + 6 + 30;
  const titleLines = wrapWords(opts.mangaName || "Untitled", titleSize, CONTENT_R - titleX, 2, true);
  const titleAdvance = titleSize * 1.02;

  let chapterNumberText = String(opts.chapterNumber ?? "").trim();
  if (chapterNumberText && !chapterNumberText.toLowerCase().startsWith("chapter")) {
    chapterNumberText = `Chapter ${chapterNumberText}`;
  } else if (!chapterNumberText) {
    chapterNumberText = "Chapter";
  }

  const chTitleLines = opts.chapterTitle
    ? wrapWords(opts.chapterTitle, chTitleSize, CONTENT_W, 2, true)
    : [];
  const chTitleAdvance = chTitleSize * 1.08;

  const urlPadX = 22;
  const urlPadY = 14;
  const urlAdvance = urlSize * 1.3;
  const chapterUrl = opts.chapterUrl ?? null;
  const urlLines = chapterUrl ? wrapChars(chapterUrl, urlSize, CONTENT_W - urlPadX * 2, 3) : [];
  const urlPillH = chapterUrl ? urlLines.length * urlAdvance + urlPadY * 2 : 0;

  const seriesBlock = 17 * 1.2 + 22;
  const titleBlock = titleLines.length * titleAdvance;
  const dividerBlock = 52 + 46;
  const chNumBlock = 22 * 1.2 + 13;
  const chTitleBlock = chTitleLines.length * chTitleAdvance;
  const urlBlock = chapterUrl ? 40 + 15 * 1.2 + 12 + urlPillH : 0;
  const bodyH = seriesBlock + titleBlock + dividerBlock + chNumBlock + chTitleBlock + urlBlock;

  let y = headerBottom + Math.max(24, (footTop - headerBottom - bodyH) / 2);

  parts.push(
    text(CONTENT_L, baselineFromTop(y, 17), "SERIES", {
      size: 17,
      fill: INK_FAINT,
      weight: 700,
      tracking: 0.26 * 17,
    }),
  );
  y += seriesBlock;

  const titleTop = y;
  titleLines.forEach((line, i) => {
    parts.push(
      text(titleX, baselineFromTop(titleTop + i * titleAdvance, titleSize), line, {
        size: titleSize,
        fill: INK,
        weight: 700,
      }),
    );
  });
  // Accent bar spans cap-top of the first line to the baseline of the last.
  const capH = titleSize * 0.7;
  const barTop = baselineFromTop(titleTop, titleSize) - capH;
  const barBottom = baselineFromTop(titleTop + (titleLines.length - 1) * titleAdvance, titleSize);
  parts.push(rect(CONTENT_L, barTop, 6, barBottom - barTop, ORANGE, 3));
  y = titleTop + titleBlock;

  y += 52;
  parts.push(rect(CONTENT_L, y, CONTENT_W, 1.5, LINE));
  y += 46;

  parts.push(
    text(CONTENT_L, baselineFromTop(y, 22), chapterNumberText.toUpperCase(), {
      size: 22,
      fill: ORANGE,
      weight: 600,
      tracking: 0.14 * 22,
    }),
  );
  y += chNumBlock;

  if (chTitleLines.length > 0) {
    chTitleLines.forEach((line, i) => {
      parts.push(
        text(CONTENT_L, baselineFromTop(y + i * chTitleAdvance, chTitleSize), line, {
          size: chTitleSize,
          fill: INK,
          weight: 700,
        }),
      );
    });
    y += chTitleBlock;
  }

  if (chapterUrl) {
    y += 40;
    parts.push(
      text(CONTENT_L, baselineFromTop(y, 15), "SOURCE", {
        size: 15,
        fill: INK_FAINT,
        weight: 600,
        tracking: 0.18 * 15,
      }),
    );
    y += 15 * 1.2 + 12;
    const widest = Math.max(...urlLines.map((line) => advance(line, urlSize)));
    parts.push(rect(CONTENT_L, y, Math.min(CONTENT_W, widest + urlPadX * 2), urlPillH, ORANGE_SOFT, 10));
    urlLines.forEach((line, i) => {
      parts.push(
        text(CONTENT_L + urlPadX, baselineFromTop(y + urlPadY + i * urlAdvance, urlSize), line, {
          size: urlSize,
          fill: INK,
          mono: true,
          weight: 500,
        }),
      );
    });
  }

  // ---- footer ----
  parts.push(rect(CONTENT_L, footTop, CONTENT_W, 1.5, LINE));
  let footY = footTop + 30;

  for (const row of rows) {
    const mid = footY + rowH / 2;
    parts.push(
      text(CONTENT_L, baselineFromMiddle(mid, keySize), row.toUpperCase(), {
        size: keySize,
        fill: INK_FAINT,
        weight: 600,
        tracking: keyTracking,
      }),
    );
    let vx = CONTENT_L + trackedWidth(row.toUpperCase(), keySize, keyTracking, true) + 16;
    if (row === "language" && langDisplay) {
      parts.push(text(vx, baselineFromMiddle(mid, valueSize), langDisplay, { size: valueSize, fill: INK, weight: 600 }));
    } else if (row === "available") {
      if (dateFrom) {
        parts.push(text(vx, baselineFromMiddle(mid, valueSize), dateFrom, { size: valueSize, fill: INK, weight: 600 }));
        vx += advance(dateFrom, valueSize, true) + 16;
        parts.push(text(vx, baselineFromMiddle(mid, valueSize), "→", { size: valueSize, fill: ORANGE, weight: 700 }));
        vx += advance("→", valueSize, true) + 16;
      }
      parts.push(
        text(vx, baselineFromMiddle(mid, valueSize), dateTo ?? "now", { size: valueSize, fill: INK, weight: 600 }),
      );
    }
    footY += rowH + rowGap;
  }

  noteLines.forEach((line, i) => {
    parts.push(
      text(CONTENT_L, baselineFromTop(footY + i * noteAdvance, noteSize), line, {
        size: noteSize,
        fill: INK_SOFT,
      }),
    );
  });
  footY += noteAdvance * noteLines.length + 8;

  parts.push(
    text(CONTENT_R, baselineFromTop(footY, 14), "publoader", {
      size: 14,
      fill: INK_FAINT,
      weight: 600,
      tracking: 0.16 * 14,
      anchor: "end",
    }),
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LOGICAL * SCALE}" height="${LOGICAL * SCALE}" ` +
    `viewBox="0 0 ${LOGICAL} ${LOGICAL}">${parts.join("")}</svg>`
  );
}

/** Render the card as PNG bytes. */
export async function generateChapterCard(opts: ChapterCardOptions): Promise<Buffer> {
  const svg = buildChapterCardSvg(opts);
  return sharp(Buffer.from(svg, "utf8"))
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}
