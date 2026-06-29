import { describe, expect, test } from "bun:test";
import { fchmodLibraryCandidates } from "../src/safe-write.ts";

describe("safe write native chmod support", () => {
  test("enumerates macOS libSystem candidates", () => {
    expect(fchmodLibraryCandidates("darwin", "x64")).toEqual([
      "libSystem.B.dylib",
      "libSystem.dylib",
    ]);
    expect(fchmodLibraryCandidates("darwin", "arm64")).toEqual([
      "libSystem.B.dylib",
      "libSystem.dylib",
    ]);
  });

  test("enumerates Linux libc candidates for Bun-supported architectures", () => {
    expect(fchmodLibraryCandidates("linux", "x64")).toEqual([
      "libc.so.6",
      "ld-musl-x86_64.so.1",
      "libc.so",
    ]);
    expect(fchmodLibraryCandidates("linux", "arm64")).toEqual([
      "libc.so.6",
      "ld-musl-aarch64.so.1",
      "libc.so",
    ]);
  });

  test("does not use native chmod FFI on unsupported platforms", () => {
    expect(fchmodLibraryCandidates("win32", "x64")).toEqual([]);
    expect(fchmodLibraryCandidates("freebsd", "x64")).toEqual([]);
  });
});
