import { describe, expect, it } from "vitest";
import { MdRequestError, isUploadSessionConflict, optimisticLockVersion } from "../../src/core/md/client.js";

/**
 * The rejection that says the account already holds an open upload session.
 *
 * MangaDex allows one per account. Both queues delete a stale session before
 * they begin, but that clearing believes `GET /upload` — and when the read is
 * wrong, the begin is refused with nothing left to recover it: the task fails,
 * retries into the same wrong answer, and dead-letters. Uploads and cards go
 * the same way.
 *
 * The predicate has to stay narrow. What it green-lights is deleting whatever
 * session the account has open, which on a false positive is somebody's live
 * upload.
 */
describe("isUploadSessionConflict", () => {
  const err = (status: number, title: string, detail: string) =>
    new MdRequestError(`POST /upload/begin failed: ${status} ${detail}`, status, {
      result: "error",
      errors: [{ status, title, detail }],
    });

  it("recognises the rejection on 409", () => {
    expect(
      isUploadSessionConflict(
        err(409, "upload_session_already_exists", "You already have an upload session"),
      ),
    ).toBe(true);
  });

  it("recognises it on 400 too, since the status is not pinned down", () => {
    expect(
      isUploadSessionConflict(
        err(400, "bad_request", "An upload session already exists, delete it first"),
      ),
    ).toBe(true);
  });

  it("reads the raw message when the body is not the documented shape", () => {
    const raw = new MdRequestError(
      'POST /upload/begin failed: 409 {"errors":[{"detail":"upload session already exists"}]}',
      409,
      null,
    );
    expect(isUploadSessionConflict(raw)).toBe(true);
  });

  it("does NOT claim an optimistic-lock conflict", () => {
    // The dangerous confusion: both arrive as 409, but this one is fixed by
    // replaying with the version MangaDex named, never by deleting a session.
    const lock = err(
      409,
      "optimistic_lock_exception",
      "The optimistic lock failed, version 2 was expected, but is actually 3",
    );
    expect(isUploadSessionConflict(lock)).toBe(false);
    // And the existing handler still claims it, so the two stay disjoint.
    expect(optimisticLockVersion(lock)).toBe(3);
  });

  it("ignores unrelated failures", () => {
    expect(isUploadSessionConflict(err(403, "forbidden", "not your chapter"))).toBe(false);
    expect(isUploadSessionConflict(err(409, "conflict", "some other conflict"))).toBe(false);
    expect(isUploadSessionConflict(new Error("network died"))).toBe(false);
    expect(isUploadSessionConflict(null)).toBe(false);
  });

  it("does not fire on a 500 that happens to mention a session", () => {
    expect(isUploadSessionConflict(err(500, "server_error", "upload session already exists"))).toBe(
      false,
    );
  });
});
