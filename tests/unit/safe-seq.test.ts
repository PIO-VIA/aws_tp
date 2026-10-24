import { describe, it, expect } from "vitest";
import { safeUpToSeq } from "../../collab/server";

describe("C-01 T1 (unitaire) — safeUpToSeq", () => {
  it("inFlight vide -> state.latestSeq", () => {
    const res = safeUpToSeq({ latestSeq: 10, inFlight: new Set() });
    expect(res).toBe(10);
  });

  it("ensemble {5, 7} avec latest=9 -> min(inFlight) - 1 = 4", () => {
    const res = safeUpToSeq({ latestSeq: 9, inFlight: new Set([5, 7]) });
    expect(res).toBe(4);
  });

  it("ensemble {9} avec latest=9 -> min(inFlight) - 1 = 8", () => {
    const res = safeUpToSeq({ latestSeq: 9, inFlight: new Set([9]) });
    expect(res).toBe(8);
  });
});
