import { describe, expect, test } from "bun:test";
import { crc32 } from "../src/crc32.ts";

describe("crc32", () => {
  test("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});
