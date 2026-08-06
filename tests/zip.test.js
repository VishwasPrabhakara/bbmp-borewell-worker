import { describe, it, expect } from "vitest";
import { crc32, stringBytes, concatBytes, makeZip } from "../src/utils/zip.js";

describe("ZIP Generation Utilities", () => {
  it("calculates CRC32 correctly", () => {
    const bytes = stringBytes("123456789");
    expect(crc32(bytes)).toBe(0xcbf43926);
  });

  it("concatenates byte arrays", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4]);
    const result = concatBytes([a, b]);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("creates valid ZIP archive buffers", () => {
    const files = [
      { name: "test.txt", data: "Hello World" }
    ];
    const zipBuffer = makeZip(files);
    expect(zipBuffer).toBeInstanceOf(Uint8Array);
    expect(zipBuffer.length).toBeGreaterThan(50);
    // Check ZIP Local File Header signature (0x04034b50)
    expect(zipBuffer[0]).toBe(0x50);
    expect(zipBuffer[1]).toBe(0x4b);
    expect(zipBuffer[2]).toBe(0x03);
    expect(zipBuffer[3]).toBe(0x04);
  });
});
