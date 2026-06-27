import { describe, expect, test } from "bun:test";
import { BufferRangeSource } from "../src/range-source.ts";
import { ZipArchive } from "../src/zip.ts";
import { makeZip } from "./zip-fixtures.ts";

describe("ZipArchive", () => {
  test("lists central directory entries", async () => {
    const archive = ZipArchive.fromBuffer(
      makeZip([
        { path: "dir/" },
        { path: "dir/a.txt", data: "alpha" },
        { path: "b.txt", data: "bravo", method: 8 },
      ]),
      "fixture.zip",
    );

    const entries = await archive.entries();
    expect(entries.map((entry) => [entry.path, entry.kind, entry.compressionMethod])).toEqual([
      ["dir", "directory", 0],
      ["dir/a.txt", "file", 0],
      ["b.txt", "file", 8],
    ]);
  });

  test("reads stored and deflated entry data with CRC checks", async () => {
    const archive = ZipArchive.fromBuffer(
      makeZip([
        { path: "stored.txt", data: "stored" },
        { path: "deflated.txt", data: "deflated", method: 8 },
      ]),
      "fixture.zip",
    );

    const entries = await archive.entries();
    const stored = entries.find((entry) => entry.path === "stored.txt")!;
    const deflated = entries.find((entry) => entry.path === "deflated.txt")!;

    expect(new TextDecoder().decode(await archive.readEntry(stored, { checkCrc: true }))).toBe(
      "stored",
    );
    expect(new TextDecoder().decode(await archive.readEntry(deflated, { checkCrc: true }))).toBe(
      "deflated",
    );
  });

  test("reports CRC mismatch", async () => {
    const archive = ZipArchive.fromBuffer(
      makeZip([
        {
          path: "bad.txt",
          data: "bad",
          crc32: 0,
        },
      ]),
      "fixture.zip",
    );
    const [entry] = await archive.entries();

    await expect(archive.readEntry(entry!, { checkCrc: true })).rejects.toThrow("CRC32 mismatch");
  });

  test("refuses zip slip names while listing", async () => {
    const archive = ZipArchive.fromBuffer(
      makeZip([
        {
          path: "../evil.txt",
          data: "bad",
        },
      ]),
      "fixture.zip",
    );

    await expect(archive.entries()).rejects.toThrow("refused path with '..'");
  });

  test("reads bounded byte ranges from buffers", async () => {
    const source = new BufferRangeSource(new Uint8Array([1, 2, 3, 4]), "bytes");
    expect(Array.from(await source.read(1, 2))).toEqual([2, 3]);
    await expect(source.read(3, 2)).rejects.toThrow("range exceeds");
  });
});
