/*
 * Screenshot every destination of the live dashboard. Not an assertion suite;
 * a design review tool. Run it the same way as the others:
 *
 *   ./test/browser/run.sh shots.mjs
 *
 * PNGs land in test/browser/.shots/ (gitignored).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { launch } from "./cdp.mjs";

const O = process.env.DASH_ORIGIN ?? "http://127.0.0.1:8101";
const ADMIN_TOKEN = "dev-admin-not-a-secret";
const OUT = new URL("./.shots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await launch();
const page = await browser.newPage();

const shot = async (name, { full = false } = {}) => {
  const res = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: full,
  });
  writeFileSync(`${OUT}${name}.png`, Buffer.from(res.data, "base64"));
  console.log(`shot ${name}`);
};

await page.goto(`${O}/`, 1200);
await shot("00-sign-in");

await page.eval(`
  document.getElementById("login-token-toggle").click();
  document.getElementById("login-token").value = ${JSON.stringify(ADMIN_TOKEN)};
  document.getElementById("login-actor").value = "ardax";
  document.getElementById("login-token-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return true;`);
await page.waitFor(`document.getElementById("app").hidden === false`, { label: "app shown" });
await page.settle(1500);

const ROUTES = [
  ["01-overview", "#/overview"],
  ["02-runs", "#/runs"],
  ["03-queues", "#/queues"],
  ["04-activity", "#/activity"],
  ["05-errors", "#/errors"],
  ["06-extensions", "#/extensions"],
  ["07-tracked", "#/tracked"],
  ["08-untracked", "#/untracked"],
  ["09-workers", "#/workers"],
  ["10-users", "#/users"],
  ["11-tokens", "#/tokens"],
  ["12-audit", "#/audit"],
  ["13-system", "#/system"],
  ["14-docs", "#/docs"],
];

for (const [name, hash] of ROUTES) {
  await page.goto(`${O}/${hash}`, 1400);
  await shot(name);
}

// The profile menu, which no route reaches on its own.
await page.goto(`${O}/#/overview`, 1200);
await page.eval(`document.getElementById("profile-toggle").click(); return true;`);
await page.settle(300);
await shot("15-profile-menu");
await page.eval(`document.getElementById("profile-toggle").click(); return true;`);

// Phone width, where tables restack as cards and the rail becomes a drawer;
// the layout that desktop screenshots say nothing about.
await page.send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
for (const [name, hash] of [
  ["20-phone-overview", "#/overview"],
  ["21-phone-queues", "#/queues"],
  ["22-phone-workers", "#/workers"],
]) {
  await page.goto(`${O}/${hash}`, 1400);
  await shot(name);
}
await page.eval(`document.getElementById("nav-toggle").click(); return true;`);
await page.settle(400);
await shot("23-phone-drawer");

console.log(`\nPNGs in ${OUT}`);
await browser.close();
