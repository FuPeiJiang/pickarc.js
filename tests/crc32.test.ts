import { describe, expect, test } from "bun:test";
import { Crc32, crc32 } from "../src/crc32.ts";

describe("crc32", () => {
  test("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("supports incremental updates", () => {
    const encoder = new TextEncoder();

    expect(
      new Crc32()
        .update(encoder.encode("123"))
        .update(encoder.encode("456"))
        .update(encoder.encode("789"))
        .digest(),
    ).toBe(0xcbf43926);
  });
});
