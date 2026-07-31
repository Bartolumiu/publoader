/**
 * Give the seeded owner a password and create a contributor, over HTTP.
 *
 * Separate from seed.mjs, and necessarily so: passwords are hashed by the API
 * with its own parameters, so writing the column directly through Prisma would
 * store something no login could ever match. Run this after the API is up.
 *
 * The passwords are fixtures shared with verify.mjs — change them in both.
 */
const O = process.env.DASH_ORIGIN ?? "http://127.0.0.1:8101";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev-admin-not-a-secret";
const login = await fetch(`${O}/api/v1/admin/session`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: ADMIN_TOKEN, actor: "setup" }),
});
const cookie = login.headers.getSetCookie()[0].split(";")[0];
const me = await (await fetch(`${O}/api/v1/admin/session`, { headers: { cookie } })).json();
const users = await (await fetch(`${O}/api/v1/admin/users`, { headers: { cookie } })).json();
const owner = users.users.find((u) => u.email === me.email);
const h = { cookie, "content-type": "application/json", "x-requested-with": "publoader-dash" };
console.log("set owner password:", (await fetch(`${O}/api/v1/admin/users/${owner.id}/password`, {
  method: "POST", headers: h, body: JSON.stringify({ password: "correct-horse-battery-staple" }),
})).status);
// A contributor to exercise the narrow-scope paths.
const created = await (await fetch(`${O}/api/v1/admin/users`, {
  method: "POST", headers: h, body: JSON.stringify({ email: "contrib@example.com", role: "CONTRIBUTOR" }),
})).json();
const after = await (await fetch(`${O}/api/v1/admin/users`, { headers: { cookie } })).json();
const c = after.users.find((u) => u.email === "contrib@example.com") ?? created.user ?? created;
console.log("contributor:", c.id ?? JSON.stringify(c).slice(0, 120));
if (c.id) console.log("contrib password:", (await fetch(`${O}/api/v1/admin/users/${c.id}/password`, {
  method: "POST", headers: h, body: JSON.stringify({ password: "contributor-password-1234" }),
})).status);
console.log("owner email:", me.email);
