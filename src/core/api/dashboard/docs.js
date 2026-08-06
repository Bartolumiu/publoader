/**
 * The "Read the docs" view: the repository's own documentation, in the dashboard.
 *
 * The reason this exists is that every other panel answers a question with a
 * number, and the answers an operator needs at 03:00 are prose; "what does
 * draining a worker actually do", "how do I restore a backup". Sending them to
 * GitHub for that assumes they have the repo, the network and the right branch;
 * the container already has the exact documents that match the code it is
 * running.
 *
 * Self-contained on purpose: it imports only ./markdown.js and takes its
 * integration points as an optional `host` object, so the shell can pass its own
 * helpers (or nothing at all) without this module reaching into app.js.
 */
import { renderMarkdown } from "./markdown.js";

const API = "/api/v1/admin";
const CSRF_HEADER = "x-requested-with";
const CSRF_VALUE = "publoader-dash";

/**
 * Which document is open, remembered across tab switches; the shell rebuilds a
 * view from scratch every time it is selected, and losing the operator's place
 * in deployment.md because they glanced at Overview would be its own small
 * annoyance.
 */
const state = { name: null, filter: "" };

// ------------------------------------------------------------- host fallbacks

function fallbackEl(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids.flat(3)) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

async function fallbackApi(path) {
  const res = await fetch(API + path, {
    credentials: "same-origin",
    headers: { [CSRF_HEADER]: CSRF_VALUE, accept: "application/json" },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}

function helpers(host) {
  return {
    el: host.el || fallbackEl,
    api: host.api || fallbackApi,
    card:
      host.card ||
      ((title, ...kids) =>
        fallbackEl("div", { class: "card" }, title ? fallbackEl("h2", { text: title }) : null, ...kids)),
    toast: host.toast || ((message) => console.warn(message)),
  };
}

// -------------------------------------------------------------------- the view

/**
 * Build the docs view. Returns a node, matching the shell's convention that a
 * view is `async () => Node`.
 */
export async function viewDocs(host = {}) {
  const { el, api, card, toast } = helpers(host);

  let listing;
  try {
    listing = await api("/docs");
  } catch (err) {
    return card("Documentation", el("p", { class: "error", text: err.message }));
  }

  if (!listing.available || listing.documents.length === 0) {
    // Never "there is no documentation": say why, because the fix is a build
    // argument and the operator is the person who can apply it.
    return card(
      "Documentation",
      el("p", { class: "error", text: "No documents are available in this build." }),
      el("p", { class: "dim", text: listing.reason || "The docs directory is empty." }),
    );
  }

  const documents = listing.documents;
  if (!documents.some((doc) => doc.name === state.name)) {
    state.name = (documents.find((doc) => doc.name === "operations.md") || documents[0]).name;
  }

  const body = el("div", { class: "doc-body" });
  const contents = el("nav", { class: "doc-contents", "aria-label": "In this document" });
  const heading = el("h2", { text: "Documentation" });
  const index = el("div", { class: "doc-index" });

  const filter = el("input", {
    type: "search",
    placeholder: "Filter documents…",
    value: state.filter,
    "aria-label": "Filter documents",
    oninput: (event) => {
      state.filter = event.target.value;
      drawIndex();
    },
  });

  function drawIndex() {
    const needle = state.filter.trim().toLowerCase();
    const matching = documents.filter(
      (doc) =>
        !needle || doc.name.toLowerCase().includes(needle) || doc.title.toLowerCase().includes(needle),
    );
    index.replaceChildren(
      ...(matching.length === 0
        ? [el("p", { class: "dim", text: "No document matches." })]
        : matching.map((doc) =>
            el("button", {
              type: "button",
              class: `doc-link${doc.name === state.name ? " active" : ""}`,
              "aria-current": doc.name === state.name ? "page" : null,
              title: `${doc.name} · ${Math.round(doc.bytes / 1024)} KB`,
              text: doc.title,
              onclick: () => void open(doc.name),
            }),
          )),
    );
  }

  /** Load and render one document. */
  async function open(name) {
    state.name = name;
    drawIndex();
    body.replaceChildren(el("p", { class: "dim", text: `Loading ${name}…` }));
    contents.replaceChildren();
    let doc;
    try {
      doc = await api(`/docs/${encodeURIComponent(name)}`);
    } catch (err) {
      body.replaceChildren(el("p", { class: "error", text: `${name}: ${err.message}` }));
      return;
    }
    heading.textContent = doc.title;

    const article = el("article", { class: "markdown" });
    // The ONE place this module assigns HTML. Everything in it came out of
    // renderMarkdown, which escapes its input before formatting it and emits no
    // attribute it did not construct itself (see markdown.js). Setting
    // textContent here instead would show the operator raw markdown.
    article.innerHTML = renderMarkdown(doc.markdown);
    article.addEventListener("click", onArticleClick);
    body.replaceChildren(
      el(
        "p",
        { class: "dim doc-meta" },
        `${doc.name} · ${Math.round(doc.bytes / 1024)} KB · updated ${new Date(doc.modified).toLocaleString()}`,
      ),
      article,
    );
    drawContents(article);
  }

  /** A per-document table of contents, from the headings the renderer gave ids. */
  function drawContents(article) {
    const headings = [...article.querySelectorAll("h2[id], h3[id]")];
    if (headings.length < 2) {
      contents.replaceChildren();
      return;
    }
    contents.replaceChildren(
      el("h3", { text: "On this page" }),
      el(
        "ul",
        {},
        headings.map((node) =>
          el(
            "li",
            { class: node.tagName === "H3" ? "sub" : null },
            el("a", {
              href: `#${node.id}`,
              text: node.textContent,
              onclick: (event) => {
                event.preventDefault();
                node.scrollIntoView({ behavior: "smooth", block: "start" });
              },
            }),
          ),
        ),
      ),
    );
  }

  /**
   * Keep in-document and cross-document links inside the viewer.
   *
   * Both would otherwise be broken in a way that looks like our bug: `#section`
   * navigates the SPA's own URL and scrolls nowhere, and `operations.md` resolves
   * against /dash/ and 404s. Anchors and sibling documents are the two link
   * shapes our docs actually use, so both are handled; an absolute http(s) link
   * is left to the browser, which opens it in a new tab.
   */
  function onArticleClick(event) {
    const link = event.target.closest("a[href]");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!href || /^https?:/i.test(href) || href.startsWith("mailto:")) return;

    event.preventDefault();
    if (href.startsWith("#")) {
      const target = document.getElementById(href.slice(1));
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      else toast(`This document has no section "${href.slice(1)}".`, false);
      return;
    }

    // `guide/thing.md#frag` → the endpoint serves flat names, so only the
    // basename can be resolved. A link we cannot resolve says so rather than
    // doing nothing when clicked.
    const [path, fragment] = href.split("#");
    const name = path.split("/").pop();
    if (!documents.some((doc) => doc.name === name)) {
      toast(`"${name}" is not one of the documents shipped with this build.`, false);
      return;
    }
    void open(name).then(() => {
      if (!fragment) {
        body.scrollIntoView({ block: "start" });
        return;
      }
      const target = document.getElementById(fragment);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  drawIndex();
  void open(state.name);

  return card(
    null,
    el(
      "div",
      { class: "doc-layout" },
      el("aside", { class: "doc-sidebar" }, el("h2", { text: "Documents" }), filter, index, contents),
      el("section", { class: "doc-main" }, heading, body),
    ),
  );
}

export default viewDocs;
