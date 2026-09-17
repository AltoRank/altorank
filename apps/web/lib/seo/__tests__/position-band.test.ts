// ---------------------------------------------------------------------------
// Measured demand extends striking distance; a bare position does not
// ---------------------------------------------------------------------------
//
// altorank.co, 2026-09-17: "ranking coach alternative" at position 29 with
// 171 Search Console impressions scored below "site rank", a 9,900/mo volume
// estimate the site had never appeared for. The scorer's striking band
// stopped at 20 whatever the evidence behind the position.

import { describe, it, expect } from "vitest";
import { positionBand } from "../recommendations";

describe("positionBand", () => {
  it("keeps the classic bands for a position from a SERP snapshot", () => {
    expect(positionBand(3, null)).toBe("won");
    expect(positionBand(10, null)).toBe("won");
    expect(positionBand(11, null)).toBe("striking");
    expect(positionBand(20, null)).toBe("striking");
    expect(positionBand(21, null)).toBe("ranking");
    expect(positionBand(29, null)).toBe("ranking");
    expect(positionBand(null, 500)).toBeNull();
  });

  it("treats a measured page-3 term as striking distance", () => {
    expect(positionBand(29, 171)).toBe("striking");
    expect(positionBand(37, 139)).toBe("striking");
    expect(positionBand(40, 50)).toBe("striking");
  });

  it("does not extend the band on thin evidence or past page four", () => {
    expect(positionBand(29, 49)).toBe("ranking");
    expect(positionBand(29, 0)).toBe("ranking");
    expect(positionBand(41, 1000)).toBe("ranking");
  });

  it("never turns a won position into striking, however many impressions", () => {
    expect(positionBand(8, 10000)).toBe("won");
  });
});
