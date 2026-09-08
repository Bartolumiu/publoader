/**
 * What build this process is.
 *
 * Workers used to report `agentVersion: "1.0.0"` forever — a default string in
 * the `CoreApiClient` constructor that nothing ever overrode and nothing ever
 * bumped. It looked like a version, which is worse than showing nothing: an
 * operator reading the Workers table could not tell a host running last week's
 * image from one running today's, and neither could the audit trail.
 *
 * The stamp is passed in at image build time (`PUBLOADER_BUILD`, set from the
 * build arg of the same name in docker/{core,worker}/Dockerfile, which CI fills
 * with `<release version or dev>+<short sha>`). It is deliberately NOT read from
 * package.json: that file says 1.0.0, has never been bumped since the platform
 * rewrite, and releases are cut from git tags instead — so it would only be a
 * second thing that lies.
 *
 * Outside a built image there is no honest answer, and `dev` says so.
 */
export const VERSION = process.env["PUBLOADER_BUILD"]?.trim() || "dev";
