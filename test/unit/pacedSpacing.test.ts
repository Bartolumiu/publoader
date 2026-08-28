import { describe, expect, it } from "vitest";
import { pacedSpacing } from "../../src/core/md/client.js";

/**
 * How hard this platform hits MangaDex.
 *
 * The pace used to be a fixed interval, and it had to be set for the worst
 * case: the limit is per IP while the gate is per process, so core-api,
 * core-processor and core-uploader each kept a private metronome and none of
 * them could see the other two spending the same allowance. It sat at 2000ms,
 * a tenth of what MangaDex permits, and every card paid about twelve seconds
 * of pure waiting for it.
 *
 * These headers describe the SHARED budget, so all three observe the same
 * depletion and back off together without knowing about each other. That makes
 * this arithmetic the thing standing between a fast platform and a banned one,
 * which is why it is a pure function with its own tests rather than something
 * only exercised by a client that really sleeps.
 */
describe("pacedSpacing", () => {
  const headers = (values: Record<string, string>): Headers => new Headers(values);
  const NOW = 1_000_000_000_000;

  it("says nothing when the headers are absent", () => {
    // Not every route sends them, and a missing header is not a reading of
    // zero: the caller keeps the pace it had rather than inventing one.
    expect(pacedSpacing(headers({}), NOW)).toBeNull();
  });

  it("says nothing when the headers are not numbers", () => {
    expect(
      pacedSpacing(headers({ "x-ratelimit-remaining": "lots", "x-ratelimit-retry-after": "soon" }), NOW),
    ).toBeNull();
  });

  it("spreads what is left across the time left", () => {
    // 10 requests, 5 seconds: one every 500ms.
    const paced = pacedSpacing(
      headers({
        "x-ratelimit-remaining": "10",
        "x-ratelimit-retry-after": String((NOW + 5_000) / 1000),
      }),
      NOW,
    );
    expect(paced).toEqual({ spacingMs: 500, waitMs: 0 });
  });

  it("widens as the budget runs down", () => {
    const early = pacedSpacing(
      headers({ "x-ratelimit-remaining": "40", "x-ratelimit-retry-after": String((NOW + 20_000) / 1000) }),
      NOW,
    );
    const late = pacedSpacing(
      headers({ "x-ratelimit-remaining": "4", "x-ratelimit-retry-after": String((NOW + 20_000) / 1000) }),
      NOW,
    );
    expect(early?.spacingMs).toBe(500);
    expect(late?.spacingMs).toBe(5_000);
    expect(late!.spacingMs).toBeGreaterThan(early!.spacingMs);
  });

  it("waits for the reset once the budget is spent", () => {
    // Nothing left. Pausing here costs one wait; spending it costs a 429 for
    // whichever caller happens to arrive first.
    const paced = pacedSpacing(
      headers({ "x-ratelimit-remaining": "0", "x-ratelimit-retry-after": String((NOW + 3_000) / 1000) }),
      NOW,
    );
    expect(paced?.waitMs).toBe(4_000);
    expect(paced?.spacingMs).toBe(0);
  });

  it("falls back to the floor once the window has rolled", () => {
    // A stale reading describes a window that is already over, and pacing off
    // it would keep the client slow for no reason.
    const paced = pacedSpacing(
      headers({ "x-ratelimit-remaining": "1", "x-ratelimit-retry-after": String((NOW - 10_000) / 1000) }),
      NOW,
    );
    expect(paced).toEqual({ spacingMs: 0, waitMs: 0 });
  });

  it("caps the gap rather than stalling on arithmetic", () => {
    // One request left and ten minutes to go computes a ten-minute gap. Past
    // the cap, waiting for the reset is the better trade than pacing to it.
    const paced = pacedSpacing(
      headers({ "x-ratelimit-remaining": "1", "x-ratelimit-retry-after": String((NOW + 600_000) / 1000) }),
      NOW,
    );
    expect(paced?.spacingMs).toBe(5_000);
  });
});
