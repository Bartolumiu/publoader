// Dev-stack bootstrap: mint one enrollment token per worker so
// `docker compose up` produces a working two-worker fleet with no manual step.
//
// Production enrollment is deliberately manual; an operator mints a
// single-use token and hands it to a host they chose to trust (§8). Automating
// it is acceptable HERE and only here, because this stack is throwaway, is
// bound to localhost, and its admin token is the literal string "dev-admin-not-a-secret".
//
// Runs on the core image (node, no curl) and writes the tokens to a shared
// volume; the workers read them via ENROLL_TOKEN_FILE, which config.ts
// supports for every variable. Exits 0 when both tokens exist.

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CORE = process.env.CORE_URL ?? "http://core-api:8100";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const OUT_DIR = process.env.BOOTSTRAP_DIR ?? "/bootstrap";
const WORKERS = (process.env.BOOTSTRAP_WORKERS ?? "a,b").split(",").filter(Boolean);

mkdirSync(OUT_DIR, { recursive: true });

// The API is up before it is useful: migrate has run, but Fastify still has to
// bind. Poll /healthz rather than racing it.
let ready = false;
for (let attempt = 0; attempt < 60 && !ready; attempt++) {
  try {
    const res = await fetch(`${CORE}/healthz`);
    ready = res.ok;
  } catch {
    // core-api not listening yet
  }
  if (!ready) await sleep(1000);
}
if (!ready) {
  console.error(`bootstrap: ${CORE}/healthz never became ready`);
  process.exit(1);
}

for (const name of WORKERS) {
  const path = `${OUT_DIR}/enroll-${name}`;
  // Enrollment tokens are single-use. If a token file is already here the
  // worker either consumed it (and persisted its real worker token) or has not
  // started yet; either way, minting a second one would strand the first.
  if (existsSync(path)) {
    console.log(`bootstrap: ${path} exists, leaving it alone`);
    continue;
  }
  const res = await fetch(`${CORE}/api/v1/admin/enroll-tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
      "x-actor": "dev-bootstrap",
    },
    body: JSON.stringify({ trust: "TRUSTED", note: `dev worker-${name}`, ttlHours: 24 }),
  });
  if (!res.ok) {
    console.error(`bootstrap: mint failed for worker-${name}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const body = await res.json();
  // The admin route returns {token, expiresAt}; the fallbacks keep this
  // working if that field is ever renamed rather than failing cryptically.
  const token = body.token ?? body.enrollToken ?? body.value;
  if (typeof token !== "string" || !token) {
    console.error(`bootstrap: unexpected mint response: ${JSON.stringify(body)}`);
    process.exit(1);
  }
  // World-readable on purpose: the workers run as a different uid and this is
  // a disposable dev credential.
  writeFileSync(path, token, { mode: 0o644 });
  console.log(`bootstrap: wrote ${path}`);
}

console.log("bootstrap: done");
