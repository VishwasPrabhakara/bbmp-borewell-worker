import { describe, it, expect } from "vitest";
import {
  normalizeWardNoValue,
  isValidWaterLevel,
  primaryLevel,
  cleanShortLevelSeries,
  dominantContinuousSegment
} from "../src/utils/data-cleaning.js";

describe("Data Cleaning Utilities", () => {
  it("normalizes ward numbers properly", () => {
    expect(normalizeWardNoValue("48.00")).toBe("48");
    expect(normalizeWardNoValue(102.0)).toBe("102");
    expect(normalizeWardNoValue(" 15 ")).toBe("15");
  });

  it("validates water level measurements", () => {
    expect(isValidWaterLevel(150.5)).toBe(true);
    expect(isValidWaterLevel(-5)).toBe(false);
    expect(isValidWaterLevel(0)).toBe(false);
    expect(isValidWaterLevel(null)).toBe(false);
  });

  it("extracts primary level prioritizing onLevel > waterLevel > offLevel", () => {
    expect(primaryLevel({ onLevel: 100, waterLevel: 80, offLevel: 60 })).toBe(100);
    expect(primaryLevel({ onLevel: null, waterLevel: 80, offLevel: 60 })).toBe(80);
    expect(primaryLevel({ onLevel: null, waterLevel: null, offLevel: 60 })).toBe(60);
    expect(primaryLevel({ onLevel: null, waterLevel: null, offLevel: null })).toBeNull();
  });

  it("filters out large unphysical jumps in short series", () => {
    const points = [{ level: 50 }, { level: 200 }];
    expect(cleanShortLevelSeries(points, "level")).toEqual([]);
  });

  it("selects dominant continuous segment", () => {
    const points = [
      { time: "2026-01-01", level: 50 },
      { time: "2026-01-02", level: 51 },
      { time: "2026-01-03", level: 52 },
      { time: "2026-01-04", level: 200 }, // jump > 80
      { time: "2026-01-05", level: 201 },
      { time: "2026-01-06", level: 202 },
      { time: "2026-01-07", level: 203 }
    ];
    const segment = dominantContinuousSegment(points, "level");
    expect(segment.length).toBe(4);
    expect(segment[0].level).toBe(200);
  });
});
