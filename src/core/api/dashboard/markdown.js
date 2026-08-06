/**
 * A small, dependency-free markdown renderer for the docs viewer.
 *
 * There is no bundler in this project and the dashboard's CSP forbids a CDN
 * (`script-src 'self'`), so marked/markdown-it are not options; and pulling a
 * general-purpose renderer in to display fifteen files we wrote ourselves would
 * be a poor trade anyway. This covers exactly the constructs our docs use.
 *
 * The one rule that matters: TEXT IS ESCAPED BEFORE IT IS FORMATTED, never
 * after. The documents are trusted, they ship in the image, but a renderer
 * that interpolates raw text into HTML is a habit that outlives its input, and
 * the next thing someone renders through it will be a bundle manifest or an
 * error message from a worker. Escaping first also makes the two remaining
 * injection routes explicit and closed:
 *
 *   - code spans and fences hold their content ESCAPED, and are pulled out
 *     before inline formatting runs so their contents cannot be reinterpreted;
 *   - link targets go through `safeUrl`, which is an allowlist. Escaping alone
 *     would happily emit href="javascript:…"; that is not an HTML-escaping
 *     problem and cannot be fixed by escaping harder.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape the five characters that can change the meaning of markup. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/**
 * Heading id, for in-document anchors. Matches the GitHub convention closely
 * enough that a `[link](#section-name)` written for GitHub resolves here too.
 */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Link targets we are willing to emit. Everything else renders as plain text:
 * `javascript:`, `data:` and `vbscript:` are the obvious ones, but the
 * allowlist is written positively so a scheme nobody has thought of yet is
 * excluded by default rather than by enumeration.
 *
 * Relative `*.md` targets are allowed because the docs cross-reference each
 * other; the viewer intercepts those clicks and navigates within itself.
 */
export function safeUrl(url) {
  const value = String(url).trim();
  if (/^#[A-Za-z0-9._-]*$/.test(value)) return value;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(value)) return value;
  if (/^mailto:[^\s"'<>]+$/i.test(value)) return value;
  if (/^[A-Za-z0-9._/-]+\.md(#[A-Za-z0-9._-]*)?$/.test(value) && !value.includes("..")) return value;
  return null;
}

// ------------------------------------------------------------------- inline

/**
 * A link target: anything but whitespace and parentheses, plus ONE level of
 * balanced parens. `javascript:alert(1)` has to be captured whole; a pattern
 * that stopped at the first `)` would hand `javascript:alert(1` to safeUrl,
 * which refuses it, and then leave a stray `)` in the text. Getting the refusal
 * right matters more than the parens do.
 */
const TARGET = "((?:[^()\\s]|\\([^()\\s]*\\))+)";

/**
 * Internal marker for a markdown hard break. It cannot come from a document:
 * renderMarkdown strips control characters from the source before parsing, which
 * is also why the code-span placeholder below is forgery-proof.
 */
const HARD_BREAK = "\u0001";

/**
 * Inline formatting for one already-block-classified run of text.
 *
 * Code spans are extracted from the RAW text first and replaced with a
 * placeholder, so `` `a_b_c` `` is not italicised and `` `<script>` `` is shown
 * rather than executed. NUL is stripped from the input so the placeholder
 * alphabet cannot be forged by the document.
 */
export function renderInline(raw) {
  const codes = [];
  let text = String(raw).replace(/\0/g, "");
  text = text.replace(/`([^`]+)`/g, (_match, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  // Images before links: the syntax differs by one leading character, and a
  // link pattern would otherwise consume the `[…](…)` half of an image.
  text = text.replace(new RegExp(`!\\[([^\\]]*)\\]\\(${TARGET}\\)`, "g"), (match, alt, url) => {
    const href = safeUrl(url);
    return href ? `<img src="${href}" alt="${alt}" loading="lazy">` : match;
  });
  text = text.replace(
    new RegExp(`\\[([^\\]]+)\\]\\(${TARGET}(?:\\s+&quot;([^&]*)&quot;)?\\)`, "g"),
    (_match, label, url, title) => {
      const href = safeUrl(url);
      // A refused target keeps its label and loses its link: the sentence still
      // reads, and nothing clickable was invented.
      if (!href) return label;
      const external = /^https?:/i.test(href);
      return (
        `<a href="${href}"${title ? ` title="${title}"` : ""}` +
        `${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`
      );
    },
  );

  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => codes[Number(index)]);
}

// -------------------------------------------------------------------- blocks

const FENCE_RE = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*$/;
const RULE_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const ITEM_RE = /^(\s*)([-*+]|\d+[.)])[ \t]+(.*)$/;
const QUOTE_RE = /^\s*>[ \t]?(.*)$/;
const TABLE_DIVIDER_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/**
 * Render a whole document.
 *
 * Returns an HTML string for `innerHTML`. Every path through here escapes, so
 * the caller does not have to know which constructs are "safe"; that knowledge
 * living in the caller is how renderers grow holes.
 */
export function renderMarkdown(source) {
  const text = String(source)
    .replace(/\r\n?/g, "\n")
    // Control characters are stripped before anything is parsed. They have no
    // meaning in markdown, and two of this module's internals (the code-span
    // placeholder and the hard-break marker) use them; so removing them here is
    // what makes those internals impossible to forge from a document.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return renderBlocks(text.split("\n")).join("\n");
}

function renderBlocks(lines) {
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const body = [];
      i += 1;
      // An unterminated fence runs to the end of the document rather than
      // falling back to paragraph parsing: showing the rest as code is the
      // failure a writer immediately notices and fixes.
      while (i < lines.length && !new RegExp(`^\\s*${marker === "`" ? "```" : "~~~"}+\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      const language = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : "";
      out.push(`<pre><code${language}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      const id = slugify(heading[2]);
      out.push(`<h${level} id="${escapeHtml(id)}">${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && (QUOTE_RE.test(lines[i]) || (inner.length > 0 && lines[i].trim() !== ""))) {
        const match = QUOTE_RE.exec(lines[i]);
        inner.push(match ? match[1] : lines[i]);
        i += 1;
      }
      // Recursive: a quote can hold any block, including another quote, which
      // is how `> > note` renders as two levels rather than as literal `>`.
      out.push(`<blockquote>${renderBlocks(inner).join("\n")}</blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const rows = [];
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(renderTable(header, aligns, rows));
      continue;
    }

    if (ITEM_RE.test(line)) {
      const block = [];
      while (i < lines.length && lines[i].trim() !== "" && (ITEM_RE.test(lines[i]) || /^\s+\S/.test(lines[i]))) {
        block.push(lines[i]);
        i += 1;
      }
      out.push(renderList(block));
      continue;
    }

    const paragraph = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !RULE_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !ITEM_RE.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    // Two trailing spaces is markdown's hard break; everything else in a
    // paragraph is a soft wrap and joins with a space. The break is carried
    // through renderInline as a marker rather than as `<br>`, because escaping
    // happens in there and would turn the tag into visible text.
    let text = "";
    paragraph.forEach((part, index) => {
      if (index > 0) text += /[ \t]{2,}$/.test(paragraph[index - 1]) ? HARD_BREAK : " ";
      text += part.trim();
    });
    out.push(`<p>${renderInline(text).split(HARD_BREAK).join("<br>")}</p>`);
  }

  return out;
}

/**
 * A table is a row of cells followed by a divider row. Checked in the paragraph
 * loop too, so a table that follows a line of prose without a blank line between
 * them is still a table rather than being swallowed into the paragraph.
 */
function isTableStart(lines, i) {
  return (
    lines[i].includes("|") &&
    i + 1 < lines.length &&
    lines[i + 1].includes("-") &&
    TABLE_DIVIDER_RE.test(lines[i + 1])
  );
}

/** Cells of one table row, without the leading/trailing pipe. */
function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function alignOf(spec) {
  const left = spec.startsWith(":");
  const right = spec.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function renderTable(header, aligns, rows) {
  // A class, not `style="text-align:…"`: the dashboard's CSP is `style-src
  // 'self'`, which blocks inline style ATTRIBUTES as well as <style> blocks, so
  // an inline alignment would be silently dropped by the browser. See the
  // `.md-left/.md-center/.md-right` rules in style.css.
  const cell = (tag, value, index) => {
    const align = aligns[index] ? ` class="md-${aligns[index]}"` : "";
    return `<${tag}${align}>${renderInline(value ?? "")}</${tag}>`;
  };
  const head = `<tr>${header.map((value, index) => cell("th", value, index)).join("")}</tr>`;
  const body = rows
    .map((row) => `<tr>${header.map((_h, index) => cell("td", row[index], index)).join("")}</tr>`)
    .join("");
  // The wrapper is what keeps a wide table from making the whole page scroll
  // sideways; style.css gives `.md-table` its overflow.
  return `<div class="md-table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/**
 * Render a list block, nesting by indentation.
 *
 * A stack rather than recursion over the text: indentation in real documents is
 * inconsistent (two spaces here, four there, a tab in the file someone edited on
 * a different machine), so levels are tracked by *relative* depth; each new
 * indent that exceeds the current one opens exactly one level, which is what the
 * writer meant however many spaces they used.
 */
function renderList(lines) {
  const items = [];
  for (const line of lines) {
    const match = ITEM_RE.exec(line);
    if (match) {
      items.push({
        indent: match[1].replace(/\t/g, "  ").length,
        ordered: /\d/.test(match[2]),
        text: match[3],
        children: [],
      });
    } else if (items.length > 0) {
      // A continuation line belongs to the item above it.
      items[items.length - 1].text += ` ${line.trim()}`;
    }
  }

  const roots = [];
  const stack = [];
  for (const item of items) {
    while (stack.length > 0 && item.indent <= stack[stack.length - 1].indent) stack.pop();
    if (stack.length === 0) roots.push(item);
    else stack[stack.length - 1].children.push(item);
    stack.push(item);
  }
  return renderItems(roots);
}

function renderItems(items) {
  if (items.length === 0) return "";
  const tag = items[0].ordered ? "ol" : "ul";
  const body = items
    .map((item) => `<li>${renderInline(item.text)}${renderItems(item.children)}</li>`)
    .join("");
  return `<${tag}>${body}</${tag}>`;
}
