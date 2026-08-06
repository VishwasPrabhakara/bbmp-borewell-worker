import { describe, it, expect } from "vitest";
import { median, percentile, roundNumber, normalCdf, trendMethods, combinedGroundwaterStatus } from "../src/utils/math.js";

describe("Math Utilities", () => {
  it("computes median correctly", () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("computes percentile correctly", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 1.0)).toBe(40);
  });

  it("rounds numbers accurately", () => {
    expect(roundNumber(3.14159, 2)).toBe(3.14);
    expect(roundNumber(10, 4)).toBe(10);
    expect(roundNumber("invalid")).toBeNull();
  });

  it("computes normal CDF", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 4);
    expect(normalCdf(1.96)).toBeGreaterThan(0.97);
    expect(normalCdf(-1.96)).toBeLessThan(0.03);
  });

  it("computes trend methods for groundwater decline", () => {
    const points = [
      { label: "W1", level: 10, index: 1 },
      { label: "W2", level: 12, index: 2 },
      { label: "W3", level: 14, index: 3 },
      { label: "W4", level: 16, index: 4 }
    ];
    const comparisons = [
      { changeFtPerWeek: 2 },
      { changeFtPerWeek: 2 },
      { changeFtPerWeek: 2 }
    ];
    const res = trendMethods(points, comparisons);
    expect(res.linearSlopeFtPerWeek).toBe(2);
    expect(res.senSlopeFtPerWeek).toBe(2);
    expect(res.mannKendallS).toBeGreaterThan(0);
  });

  it("evaluates combined groundwater status", () => {
    const methods = {
      linearSlopeFtPerWeek: 0.5,
      mannKendallS: 6,
      mannKendallPValue: 0.01
    };
    const status = combinedGroundwaterStatus(methods, true);
    expect(status.status).toBe("Critical");
    expect(status.direction).toBe("Declining");
  });
});
