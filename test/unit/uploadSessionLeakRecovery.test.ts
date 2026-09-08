import { describe, expect, it, vi } from "vitest";

import { UploadTaskWorkers, type TaskWorkerDeps } from "../../src/core/md/taskWorkers.js";
import { MdRequestError } from "../../src/core/md/client.js";
import type { Logger } from "../../src/logging.js";

/**
 * Recovering the begin that a leaked upload session refused.
 *
 * All three begin sites delete a stale session first, but that clearing
 * believes `GET /upload`. When the read is wrong the begin is refused, nothing
 * recovers it, and the task retries into the same wrong answer until it
 * dead-letters -- which is how both an upload and a card die.
 */
describe("beginWithLeakRecovery", () => {
  const conflict = () =>
    new MdRequestError("POST /upload/begin failed: 409", 409, {
      result: "error",
      errors: [{ status: 409, title: "conflict", detail: "You already have an upload session" }],
    });

  const log = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  const build = (open: { id: string } | null) => {
    const currentUploadSession = vi.fn().mockResolvedValue(open);
    const deleteUploadSession = vi.fn().mockResolvedValue(undefined);
    const workers = new UploadTaskWorkers({
      md: { currentUploadSession, deleteUploadSession },
      notifier: { enabled: false },
    } as unknown as TaskWorkerDeps);

    const run = <T>(begin: () => Promise<T>) =>
      (
        workers as unknown as {
          beginWithLeakRecovery: (
            md: unknown,
            log: Logger,
            what: string,
            begin: () => Promise<T>,
          ) => Promise<T>;
        }
      ).beginWithLeakRecovery({ currentUploadSession, deleteUploadSession }, log, "test", begin);

    return { run, currentUploadSession, deleteUploadSession };
  };

  it("passes a successful begin straight through, touching nothing", async () => {
    const { run, currentUploadSession, deleteUploadSession } = build({ id: "leaked" });
    const begin = vi.fn().mockResolvedValue({ id: "session-1" });

    await expect(run(begin)).resolves.toEqual({ id: "session-1" });
    expect(begin).toHaveBeenCalledTimes(1);
    // The happy path must never reach for the delete: it would be deleting the
    // session it has just been handed.
    expect(currentUploadSession).not.toHaveBeenCalled();
    expect(deleteUploadSession).not.toHaveBeenCalled();
  });

  it("deletes the leaked session and retries once", async () => {
    const { run, deleteUploadSession } = build({ id: "leaked" });
    const begin = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValue({ id: "session-2" });

    await expect(run(begin)).resolves.toEqual({ id: "session-2" });
    expect(deleteUploadSession).toHaveBeenCalledWith("leaked");
    expect(begin).toHaveBeenCalledTimes(2);
  });

  it("still retries when GET /upload denies the session that just refused us", async () => {
    // The case the preemptive check cannot cover, and the reason this exists.
    const { run, deleteUploadSession } = build(null);
    const begin = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValue({ id: "session-3" });

    await expect(run(begin)).resolves.toEqual({ id: "session-3" });
    expect(deleteUploadSession).not.toHaveBeenCalled();
    expect(begin).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry rather than looping on the delete", async () => {
    const { run, deleteUploadSession } = build({ id: "leaked" });
    const begin = vi.fn().mockRejectedValue(conflict());

    await expect(run(begin)).rejects.toThrow(MdRequestError);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(deleteUploadSession).toHaveBeenCalledTimes(1);
  });

  it("rethrows an unrelated failure without deleting anything", async () => {
    const { run, currentUploadSession, deleteUploadSession } = build({ id: "leaked" });
    const begin = vi.fn().mockRejectedValue(new MdRequestError("403 forbidden", 403, null));

    await expect(run(begin)).rejects.toThrow("403 forbidden");
    expect(begin).toHaveBeenCalledTimes(1);
    expect(currentUploadSession).not.toHaveBeenCalled();
    expect(deleteUploadSession).not.toHaveBeenCalled();
  });
});
