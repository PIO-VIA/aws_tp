import { describe, it, expect } from "vitest";
import {
  getUtcDateString,
  formatQuotaKey,
  getNextUtcMidnightEpochSec,
} from "@shared/quota/quota";

describe("Quota Helpers — UTC Keys and Midnight Reset (D-08, Section 8)", () => {
  it("génère une clé de date au format UTC strict AAAA-MM-JJ", () => {
    const fixedDate = new Date("2026-10-24T23:59:59Z");
    expect(getUtcDateString(fixedDate)).toBe("2026-10-24");

    const nextUtcDay = new Date("2026-10-25T00:00:01Z");
    expect(getUtcDateString(nextUtcDay)).toBe("2026-10-25");
  });

  it("génère la clé de quota partitionnée par writerId et date UTC", () => {
    const fixedDate = new Date("2026-10-24T12:00:00Z");
    const key = formatQuotaKey("writer-123", fixedDate);
    expect(key).toBe("writer-123#2026-10-24");
  });

  it("calcule exactement le prochain 00:00:00 UTC", () => {
    const now = new Date("2026-10-24T15:30:00Z");
    const resetEpochSec = getNextUtcMidnightEpochSec(now);
    const resetDate = new Date(resetEpochSec * 1000);

    expect(resetDate.getUTCFullYear()).toBe(2026);
    expect(resetDate.getUTCMonth()).toBe(9); // 0-indexed => October
    expect(resetDate.getUTCDate()).toBe(25);
    expect(resetDate.getUTCHours()).toBe(0);
    expect(resetDate.getUTCMinutes()).toBe(0);
    expect(resetDate.getUTCSeconds()).toBe(0);
  });
});
