// Mock MangaDex API for end-to-end tests.
//
// Deliberately dependency-free (node:http only, single file): it is built from
// the plain node base image with no install step, so `docker compose up` in
// docker/dev never needs a registry, a lockfile, or a build cache to work.
//
// It implements only what the processor and uploader actually call (see
// src/core/md/types.ts MdApi) and it is NOT a faithful MangaDex — it fakes the
// happy path so a full run can be driven end to end, and records every write
// so a test can assert on it.
//
// Test-control surface (not part of the real API):
//   GET  /_test/uploads   everything received: sessions, files, commits,
//                         edits, deletes, plus the requests it could not route
//   POST /_test/seed      inject chapters/manga so dedup paths can be exercised
//   POST /_test/reset     clear all state between test cases
//   GET  /_test/state     seeded fixtures + counters
//
// Never run this anywhere it could be mistaken for the real API: it accepts
// any credentials and returns success for every write.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8200);

/** Everything the fake has been told to pretend exists. */
let seeded = { chapters: [], manga: [], aggregate: {} };
/** Everything the system under test has done to us. */
let recorded = emptyRecord();

function emptyRecord() {
  return {
    tokenRequests: 0,
    sessions: [],
    files: [],
    commits: [],
    edits: [],
    deletes: [],
    unrouted: [],
  };
}

/** The one open upload session, mirroring MangaDex's one-per-account rule. */
let currentSession = null;

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const ok = (res, body) => json(res, 200, { result: "ok", ...body });

const mdError = (res, status, detail) =>
  json(res, status, {
    result: "error",
    errors: [{ id: randomUUID(), status, title: detail, detail }],
  });

const collection = (res, data) =>
  json(res, 200, {
    result: "ok",
    response: "collection",
    data,
    limit: 100,
    offset: 0,
    total: data.length,
  });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      // Refuse to buffer something absurd; a test that sends 100MB of pages is
      // a test bug, and OOM-ing the mock hides it.
      if (size > 128 * 1024 * 1024) reject(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const parseJson = (buf) => {
  try {
    return JSON.parse(buf.toString("utf8") || "{}");
  } catch {
    return null;
  }
};

/**
 * Minimal multipart/form-data scan: enough to report the name, filename and
 * byte length of each part, which is all a test needs to assert "three pages
 * were uploaded, in this order". It does not decode the payloads.
 */
function scanMultipart(buf, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) return [];
  const boundary = `--${(match[1] || match[2]).trim()}`;
  const parts = [];
  let index = buf.indexOf(boundary);
  while (index !== -1) {
    const start = index + boundary.length;
    const next = buf.indexOf(boundary, start);
    if (next === -1) break;
    const chunk = buf.subarray(start, next);
    const headerEnd = chunk.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headers = chunk.subarray(0, headerEnd).toString("latin1");
      const name = /name="([^"]*)"/.exec(headers)?.[1] ?? null;
      const filename = /filename="([^"]*)"/.exec(headers)?.[1] ?? null;
      // -2 drops the CRLF that precedes the next boundary.
      const bytes = Math.max(0, chunk.length - headerEnd - 4 - 2);
      if (name || filename) parts.push({ name, filename, bytes });
    }
    index = next;
  }
  return parts;
}

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://mock-md");
  } catch {
    return mdError(res, 400, "unparseable url");
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method || "GET";
  const seg = path.split("/").filter(Boolean);

  // --- liveness (compose healthcheck) ---------------------------------------
  if (path === "/healthz") return ok(res, {});

  // --- test control ---------------------------------------------------------
  if (path === "/_test/uploads") return json(res, 200, recorded);
  if (path === "/_test/state") {
    return json(res, 200, { seeded, currentSession, counts: {
      sessions: recorded.sessions.length,
      files: recorded.files.length,
      commits: recorded.commits.length,
      edits: recorded.edits.length,
      deletes: recorded.deletes.length,
      unrouted: recorded.unrouted.length,
    } });
  }
  if (path === "/_test/reset" && method === "POST") {
    recorded = emptyRecord();
    seeded = { chapters: [], manga: [], aggregate: {} };
    currentSession = null;
    return ok(res, {});
  }
  if (path === "/_test/seed" && method === "POST") {
    const body = parseJson(await readBody(req));
    if (!body) return mdError(res, 400, "invalid json");
    seeded = {
      chapters: body.chapters ?? seeded.chapters,
      manga: body.manga ?? seeded.manga,
      aggregate: body.aggregate ?? seeded.aggregate,
    };
    return ok(res, { seeded: { chapters: seeded.chapters.length, manga: seeded.manga.length } });
  }

  // --- oauth ----------------------------------------------------------------
  // The real auth URL is .../realms/mangadex/protocol/openid-connect/token;
  // match on the suffix so the client's configured base can be anything.
  if (path.endsWith("/token") && method === "POST") {
    await readBody(req);
    recorded.tokenRequests += 1;
    return json(res, 200, {
      access_token: `mock-access-${randomUUID()}`,
      refresh_token: `mock-refresh-${randomUUID()}`,
      expires_in: 900,
      refresh_expires_in: 86400,
      token_type: "Bearer",
    });
  }

  // --- reads ----------------------------------------------------------------
  // GET /chapter — the dedup lookup. Returns seeded chapters filtered by the
  // ids[]/manga/groups params the client sends; empty by default, which is the
  // "nothing uploaded yet" state most tests want.
  if (path === "/chapter" && method === "GET") {
    const ids = url.searchParams.getAll("ids[]");
    const manga = url.searchParams.get("manga");
    let data = seeded.chapters;
    if (ids.length) data = data.filter((c) => ids.includes(c.id));
    else if (manga) data = data.filter((c) => relatedId(c, "manga") === manga);
    return collection(res, data);
  }

  if (path === "/manga" && method === "GET") {
    const ids = url.searchParams.getAll("ids[]");
    const data = ids.length
      ? ids.map((id) => seeded.manga.find((m) => m.id === id) ?? mockManga(id))
      : seeded.manga;
    return collection(res, data);
  }

  // GET /manga/{id}/aggregate — volume backfill.
  if (seg[0] === "manga" && seg[2] === "aggregate" && method === "GET") {
    return json(res, 200, { result: "ok", volumes: seeded.aggregate[seg[1]] ?? {} });
  }

  // --- upload session lifecycle --------------------------------------------
  // GET /upload — is a session already open? MangaDex 404s when none is, and
  // the client is expected to treat that as "no session", not as an error.
  if (path === "/upload" && method === "GET") {
    if (!currentSession) return mdError(res, 404, "no current upload session");
    return ok(res, { data: sessionResource(currentSession) });
  }

  if (path === "/upload/begin" && method === "POST") {
    const body = parseJson(await readBody(req)) ?? {};
    if (currentSession) {
      // Mirror the real API's refusal to open a second session, so a test can
      // catch an uploader that leaks sessions.
      return mdError(res, 409, "an upload session already exists");
    }
    currentSession = {
      id: randomUUID(),
      mangaId: body.manga ?? null,
      groupIds: body.groups ?? [],
      files: [],
      startedAt: new Date().toISOString(),
    };
    recorded.sessions.push({ ...currentSession, event: "begin" });
    return json(res, 200, { result: "ok", data: sessionResource(currentSession) });
  }

  if (seg[0] === "upload" && seg.length === 2 && method === "DELETE") {
    recorded.sessions.push({ id: seg[1], event: "delete" });
    if (currentSession?.id === seg[1]) currentSession = null;
    return ok(res, {});
  }

  // POST /upload/{sessionId} — page images (multipart).
  if (seg[0] === "upload" && seg.length === 2 && method === "POST") {
    const raw = await readBody(req);
    if (!currentSession || currentSession.id !== seg[1]) {
      return mdError(res, 404, "unknown upload session");
    }
    const parts = scanMultipart(raw, req.headers["content-type"]);
    const data = parts.map((part) => {
      const file = {
        id: randomUUID(),
        sessionId: seg[1],
        originalFileName: part.filename ?? part.name ?? "unnamed",
        bytes: part.bytes,
      };
      currentSession.files.push(file);
      recorded.files.push(file);
      return {
        id: file.id,
        type: "upload_session_file",
        attributes: {
          originalFileName: file.originalFileName,
          fileHash: `mockhash-${file.id.slice(0, 12)}`,
          fileSize: file.bytes,
          mimeType: "image/png",
          version: 1,
        },
      };
    });
    return json(res, 200, { result: "ok", errors: [], data });
  }

  // POST /upload/{sessionId}/commit — becomes a chapter.
  if (seg[0] === "upload" && seg[2] === "commit" && method === "POST") {
    const body = parseJson(await readBody(req)) ?? {};
    if (!currentSession || currentSession.id !== seg[1]) {
      return mdError(res, 404, "unknown upload session");
    }
    const chapterId = randomUUID();
    const commit = {
      chapterId,
      sessionId: seg[1],
      mangaId: currentSession.mangaId,
      groupIds: currentSession.groupIds,
      draft: body.chapterDraft ?? body.draft ?? {},
      pageOrder: body.pageOrder ?? [],
      fileCount: currentSession.files.length,
      at: new Date().toISOString(),
    };
    recorded.commits.push(commit);
    // The committed chapter becomes visible to subsequent GET /chapter calls,
    // so a second run of the same job sees it and dedups instead of
    // re-uploading — the property most worth testing end to end.
    seeded.chapters.push(chapterResource(chapterId, commit));
    currentSession = null;
    return json(res, 200, { result: "ok", data: { id: chapterId, type: "chapter" } });
  }

  // --- chapter edit / delete ------------------------------------------------
  if (seg[0] === "chapter" && seg.length === 2 && method === "PUT") {
    const body = parseJson(await readBody(req)) ?? {};
    recorded.edits.push({ chapterId: seg[1], payload: body, at: new Date().toISOString() });
    const existing = seeded.chapters.find((c) => c.id === seg[1]);
    if (existing) {
      existing.attributes = { ...existing.attributes, ...body };
      existing.attributes.version = (existing.attributes.version ?? 1) + 1;
    }
    return ok(res, { data: existing ?? { id: seg[1], type: "chapter" } });
  }

  if (seg[0] === "chapter" && seg.length === 2 && method === "DELETE") {
    recorded.deletes.push({ chapterId: seg[1], at: new Date().toISOString() });
    seeded.chapters = seeded.chapters.filter((c) => c.id !== seg[1]);
    return ok(res, {});
  }

  if (seg[0] === "chapter" && seg.length === 2 && method === "GET") {
    const found = seeded.chapters.find((c) => c.id === seg[1]);
    if (!found) return mdError(res, 404, "unknown chapter");
    return json(res, 200, { result: "ok", response: "entity", data: found });
  }

  // --- anything else --------------------------------------------------------
  // Recorded rather than silently 404'd: when an e2e test fails because the
  // client called an endpoint this mock never learned, /_test/uploads says so
  // instead of leaving you guessing.
  recorded.unrouted.push({ method, path, query: url.search, at: new Date().toISOString() });
  process.stderr.write(`mock-md: unrouted ${method} ${path}${url.search}\n`);
  return mdError(res, 404, `mock-md has no route for ${method} ${path}`);
});

function relatedId(chapter, type) {
  return chapter.relationships?.find((r) => r.type === type)?.id ?? null;
}

function sessionResource(session) {
  return {
    id: session.id,
    type: "upload_session",
    attributes: {
      isCommitted: false,
      isProcessed: true,
      isDeleted: false,
      version: 1,
      createdAt: session.startedAt,
    },
  };
}

function chapterResource(id, commit) {
  const draft = commit.draft ?? {};
  return {
    id,
    type: "chapter",
    attributes: {
      volume: draft.volume ?? null,
      chapter: draft.chapter ?? null,
      title: draft.title ?? null,
      translatedLanguage: draft.translatedLanguage ?? "en",
      externalUrl: draft.externalUrl ?? null,
      version: 1,
      createdAt: commit.at,
      readableAt: commit.at,
    },
    relationships: [
      ...(commit.mangaId ? [{ id: commit.mangaId, type: "manga" }] : []),
      ...commit.groupIds.map((gid) => ({ id: gid, type: "scanlation_group" })),
    ],
  };
}

function mockManga(id) {
  return {
    id,
    type: "manga",
    attributes: { title: { en: `Mock Manga ${id.slice(0, 8)}` }, altTitles: [] },
  };
}

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`mock-md listening on ${PORT}\n`);
});

// Compose sends SIGTERM; exit promptly so `down` is not a 10s wait.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
