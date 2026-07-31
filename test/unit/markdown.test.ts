import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The dashboard's markdown renderer.
 *
 * The escaping tests are the point of this file. Everything else here could be
 * wrong and the result would be an ugly page; if escaping is wrong, a document —
 * or, later, anything else someone decides to render through this — becomes
 * script execution inside the operator's authenticated session, which is the
 * whole dashboard.
 *
 * The module is a browser ES module rather than TypeScript (there is no bundler,
 * and the page loads it directly), so it is imported through a computed
 * specifier: a literal import of an untyped .js file does not type-check. Same
 * trick as the runtime esbuild import in core/webhooks/bundleBuilder.ts.
 */
interface MarkdownModule {
  renderMarkdown(source: string): string;
  renderInline(source: string): string;
  escapeHtml(source: string): string;
  slugify(source: string): string;
  safeUrl(url: string): string | null;
}

let md: MarkdownModule;

beforeAll(async () => {
  const specifier = new URL("../../src/core/api/dashboard/markdown.js", import.meta.url).href;
  md = (await import(specifier)) as MarkdownModule;
});

describe("escaping", () => {
  it("neutralises a script tag in prose", () => {
    const html = md.renderMarkdown("Hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("neutralises an event handler in an img tag", () => {
    const html = md.renderMarkdown('An <img src=x onerror="alert(1)"> tag');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("escapes inside code spans and fences rather than dropping them", () => {
    const inline = md.renderMarkdown("Run `<script>x</script>` first");
    expect(inline).toContain("<code>&lt;script&gt;x&lt;/script&gt;</code>");

    const fenced = md.renderMarkdown(["```html", "<script>alert(1)</script>", "```"].join("\n"));
    expect(fenced).toContain('<pre><code class="language-html">');
    expect(fenced).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(fenced).not.toContain("<script>");
  });

  it("escapes a heading, and its generated id", () => {
    const html = md.renderMarkdown('# <img onerror="x">');
    expect(html).not.toContain('onerror="x"');
    expect(html).toMatch(/^<h1 id="img-onerror-x">/);
  });

  it("escapes quotes so an attribute cannot be broken out of", () => {
    // A title that closes the href attribute and adds its own is the classic
    // way past a renderer that interpolates the raw string. The payload may
    // survive as visible TEXT (it does here, because the malformed title stops
    // the link from matching at all); what must not survive is an attribute on a
    // tag we emitted.
    const html = md.renderInline('[x](https://example.com "a\\" onmouseover=alert(1) b")');
    expect(html).not.toMatch(/<a[^>]*onmouseover/);
    expect(html).not.toContain('"a\\"');
    expect(html).toContain("&quot;");
  });

  it("does not emit a javascript: or data: link", () => {
    expect(md.safeUrl("javascript:alert(1)")).toBeNull();
    expect(md.safeUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(md.safeUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(md.safeUrl("vbscript:msgbox")).toBeNull();
    // The label survives; only the link is dropped.
    const html = md.renderInline("[click me](javascript:alert(1))");
    expect(html).toBe("click me");
    expect(html).not.toContain("href");
  });

  it("accepts the target shapes the docs actually use", () => {
    expect(md.safeUrl("https://mangadex.org")).toBe("https://mangadex.org");
    expect(md.safeUrl("#section-two")).toBe("#section-two");
    expect(md.safeUrl("operations.md")).toBe("operations.md");
    expect(md.safeUrl("operations.md#backups")).toBe("operations.md#backups");
    expect(md.safeUrl("mailto:ops@example.com")).toBe("mailto:ops@example.com");
    // Traversal is refused even though it ends in .md: the viewer resolves these
    // against the docs endpoint, which has its own allowlist, and a link that
    // cannot work should not be clickable.
    expect(md.safeUrl("../../etc/passwd.md")).toBeNull();
  });

  it("cannot have its code-span placeholder forged by the document", () => {
    // NUL is the placeholder delimiter. A document containing one must not be
    // able to address an entry in the placeholder table.
    const html = md.renderInline(`before \u00000\u0000 after \`real\``);
    expect(html).toContain("<code>real</code>");
    expect(html).not.toContain("undefined");
  });
});

describe("block constructs", () => {
  it("renders headings at every level with anchor ids", () => {
    expect(md.renderMarkdown("# One")).toBe('<h1 id="one">One</h1>');
    expect(md.renderMarkdown("### Deep Section Name")).toBe(
      '<h3 id="deep-section-name">Deep Section Name</h3>',
    );
    expect(md.renderMarkdown("###### Six")).toContain("<h6");
  });

  it("joins soft-wrapped lines into one paragraph and splits on a blank line", () => {
    const html = md.renderMarkdown("one\ntwo\n\nthree");
    expect(html).toBe("<p>one two</p>\n<p>three</p>");
  });

  it("honours a two-space hard break", () => {
    expect(md.renderMarkdown("one  \ntwo")).toBe("<p>one<br>two</p>");
  });

  it("renders bold, italic, strikethrough and inline code", () => {
    const html = md.renderInline("**b** and *i* and _i2_ and ~~gone~~ and `code`");
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<em>i</em>");
    expect(html).toContain("<em>i2</em>");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain("<code>code</code>");
  });

  it("leaves underscores inside a code span alone", () => {
    expect(md.renderInline("`a_b_c`")).toBe("<code>a_b_c</code>");
  });

  it("renders a fenced block without a language", () => {
    const html = md.renderMarkdown(["```", "docker compose up -d", "```"].join("\n"));
    expect(html).toBe("<pre><code>docker compose up -d</code></pre>");
  });

  it("keeps blank lines and indentation inside a fence", () => {
    const html = md.renderMarkdown(["```", "a", "", "  b", "```"].join("\n"));
    expect(html).toBe("<pre><code>a\n\n  b</code></pre>");
  });

  it("renders an unordered and an ordered list", () => {
    expect(md.renderMarkdown("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(md.renderMarkdown("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  it("renders a blockquote, including a nested one", () => {
    expect(md.renderMarkdown("> note")).toBe("<blockquote><p>note</p></blockquote>");
    const nested = md.renderMarkdown("> > deep");
    expect(nested).toBe("<blockquote><blockquote><p>deep</p></blockquote></blockquote>");
  });

  it("renders a horizontal rule", () => {
    expect(md.renderMarkdown("---")).toBe("<hr>");
  });

  it("renders an external link with noopener and an internal one without", () => {
    const external = md.renderInline("[MangaDex](https://mangadex.org)");
    expect(external).toContain('href="https://mangadex.org"');
    expect(external).toContain('rel="noopener noreferrer"');
    const internal = md.renderInline("[ops](operations.md)");
    expect(internal).toBe('<a href="operations.md">ops</a>');
  });
});

describe("nested lists and tables", () => {
  it("nests a list by indentation, regardless of how many spaces", () => {
    const html = md.renderMarkdown(
      ["- top", "  - child", "      - grandchild", "- second"].join("\n"),
    );
    expect(html).toBe(
      "<ul>" +
        "<li>top<ul><li>child<ul><li>grandchild</li></ul></li></ul></li>" +
        "<li>second</li>" +
        "</ul>",
    );
  });

  it("mixes an ordered list inside an unordered one", () => {
    const html = md.renderMarkdown(["- steps", "  1. first", "  2. second"].join("\n"));
    expect(html).toBe("<ul><li>steps<ol><li>first</li><li>second</li></ol></li></ul>");
  });

  it("attaches a continuation line to the item above it", () => {
    const html = md.renderMarkdown(["- a long item", "  that wrapped", "- next"].join("\n"));
    expect(html).toBe("<ul><li>a long item that wrapped</li><li>next</li></ul>");
  });

  it("formats inline markup inside list items", () => {
    expect(md.renderMarkdown("- see `docs/ops.md` and **do not** skip it")).toContain(
      "<code>docs/ops.md</code>",
    );
  });

  it("renders a table with a header, alignment and inline formatting", () => {
    const html = md.renderMarkdown(
      [
        "| Key | Default | Notes |",
        "| --- | :-----: | ----: |",
        "| `PORT` | 8100 | the **only** listener |",
        "| HOST | 0.0.0.0 | |",
      ].join("\n"),
    );
    expect(html).toContain('<div class="md-table"><table><thead>');
    expect(html).toContain("<th>Key</th>");
    expect(html).toContain('<th class="md-center">Default</th>');
    expect(html).toContain('<th class="md-right">Notes</th>');
    expect(html).toContain("<td><code>PORT</code></td>");
    expect(html).toContain("the <strong>only</strong> listener");
    // A short row is padded rather than shifting the remaining cells left: the
    // last cell is empty and still carries the column's alignment.
    expect(html).toContain('<td class="md-center">0.0.0.0</td>');
    expect(html).toContain('<td class="md-right"></td>');
    expect(html.match(/<tr>/g)).toHaveLength(3);
  });

  it("escapes cell content", () => {
    const html = md.renderMarkdown(["| a |", "| - |", "| <script>x</script> |"].join("\n"));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not treat a lone pipe line as a table", () => {
    const html = md.renderMarkdown("a | b\nnot a divider");
    expect(html).toBe("<p>a | b not a divider</p>");
  });

  it("renders a document that uses every construct without throwing", () => {
    const html = md.renderMarkdown(
      [
        "# Title",
        "",
        "Intro with [a link](operations.md#backups) and `code`.",
        "",
        "## Steps",
        "",
        "1. first",
        "   - detail",
        "2. second",
        "",
        "> Warning: read this.",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "```bash",
        "echo hi",
        "```",
        "",
        "---",
      ].join("\n"),
    );
    expect(html).toContain('<h1 id="title">');
    expect(html).toContain('<h2 id="steps">');
    expect(html).toContain("<ol><li>first<ul><li>detail</li></ul></li><li>second</li></ol>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain('class="language-bash"');
    expect(html).toContain("<hr>");
  });
});

describe("the real documentation", () => {
  /**
   * Render every document that ships, as the viewer will. This is the test that
   * catches a construct we use but did not think to support — a renderer that
   * passes twenty unit tests and mangles deployment.md is no use to the operator
   * reading deployment.md at 03:00.
   */
  const docsDir = fileURLToPath(new URL("../../docs/", import.meta.url));
  const files = existsSync(docsDir) ? readdirSync(docsDir).filter((f) => f.endsWith(".md")) : [];

  it.skipIf(files.length === 0)("renders every shipped document safely", () => {
    for (const file of files) {
      const html = md.renderMarkdown(readFileSync(join(docsDir, file), "utf8"));
      expect(html.length, file).toBeGreaterThan(0);
      // No tag we did not emit ourselves, and nothing executable.
      expect(html, file).not.toMatch(/<script/i);
      expect(html, file).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html, file).not.toMatch(/javascript:/i);
      // No internal marker survives into the output.
      expect(html, file).not.toMatch(/[\u0000-\u0008]/);
    }
  });
});

describe("slugify", () => {
  it("matches the heading ids the renderer emits", () => {
    expect(md.slugify("Backups and restores")).toBe("backups-and-restores");
    expect(md.slugify("§ Weird — Punctuation!")).toBe("weird-punctuation");
    expect(md.slugify("`code` in a heading")).toBe("code-in-a-heading");
  });
});
