/**
 * Types for the two dashboard views that ship as plain ES modules.
 *
 * `dashboard/sysops.js` and `dashboard/docs.js` are browser assets, not part of
 * the server build: they are served verbatim and loaded by `app.js` through
 * `import()`, so they are `.js` with no declarations and `checkJs` is off. That
 * makes them an implicit `any` to any test that imports them, which `noImplicitAny`
 * rejects.
 *
 * Declaring the contract here rather than casting the imports to `any` at each
 * call site keeps the one thing worth type-checking: both modules must export a
 * function that takes the host object and resolves to a DOM node, because that is
 * exactly what `app.js` does with the result (`host.replaceChildren(await
 * build(moduleHost()))`). `unknown` for the host and the node is deliberate; the
 * DOM lib is not in this program's `lib`, on purpose, since adding it would
 * conflict with Node's `fetch` typing and would stop the server sources failing to
 * compile when they reach for a browser global.
 */
declare module "*/dashboard/sysops.js" {
  export function viewSysops(host?: unknown): Promise<unknown>;
  const viewSysopsDefault: typeof viewSysops;
  export default viewSysopsDefault;
}

declare module "*/dashboard/docs.js" {
  export function viewDocs(host?: unknown): Promise<unknown>;
  const viewDocsDefault: typeof viewDocs;
  export default viewDocsDefault;
}
