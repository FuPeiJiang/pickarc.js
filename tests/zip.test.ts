import { describe, expect, test } from "bun:test";
import { BufferRangeSource } from "../src/range-source.ts";
import { ZipArchive } from "../src/zip.ts";
import {
  aesLongZipFixture,
  aesZipFixture,
  makeZip,
  zipCryptoFixture,
} from "./zip-fixtures.ts";

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

  test("classifies ZIP Unix special file entries", async () => {
    const archive = ZipArchive.fromBuffer(
      makeZip([
        { path: "link", data: "target", externalAttributes: 0o120777 << 16 },
        { path: "pipe", externalAttributes: 0o010644 << 16 },
        {
          path: "tty",
          externalAttributes: 0o020600 << 16,
          extra: unixDeviceExtra(5, 1),
        },
        {
          path: "disk",
          externalAttributes: 0o060600 << 16,
          extra: unixDeviceExtra(8, 0),
        },
        { path: "sock", externalAttributes: 0o140777 << 16 },
      ]),
      "fixture.zip",
    );

    const entries = await archive.entries();
    expect(entries.map((entry) => [entry.path, entry.specialFileType])).toEqual([
      ["link", "symlink"],
      ["pipe", "fifo"],
      ["tty", "char-device"],
      ["disk", "block-device"],
      ["sock", "socket"],
    ]);
    expect(entries[2]?.deviceNumbers).toEqual({ major: 5, minor: 1 });
    expect(entries[3]?.deviceNumbers).toEqual({ major: 8, minor: 0 });
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

  test("plans read-ahead ranges from central directory estimates", async () => {
    const archive = ZipArchive.fromBuffer(
      makeZip([{ path: "file.txt", data: "abc" }]),
      "fixture.zip",
    );
    const [entry] = await archive.entries();

    expect(archive.entryPlannedRange(entry!)).toEqual({
      offset: 0,
      length: 30 + "file.txt".length + "abc".length,
    });
    expect(await archive.entryDataRange(entry!)).toEqual({
      offset: 30 + "file.txt".length,
      length: "abc".length,
    });
  });

  test("streams stored and deflated entry data in chunks", async () => {
    const archive = ZipArchive.fromBuffer(
      makeZip([
        { path: "stored.txt", data: "stored chunks" },
        { path: "deflated.txt", data: "deflated chunks", method: 8 },
      ]),
      "fixture.zip",
    );

    const entries = await archive.entries();
    const stored = entries.find((entry) => entry.path === "stored.txt")!;
    const deflated = entries.find((entry) => entry.path === "deflated.txt")!;

    expect(await readStreamText(archive.streamEntry(stored, { checkCrc: true, chunkSize: 3 }))).toBe(
      "stored chunks",
    );
    expect(
      await readStreamText(archive.streamEntry(deflated, { checkCrc: true, chunkSize: 3 })),
    ).toBe("deflated chunks");
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

  test("reads ZipCrypto encrypted entries", async () => {
    const archive = ZipArchive.fromBuffer(zipCryptoFixture(), "legacy.zip");
    const [entry] = await archive.entries();

    expect(entry?.path).toBe("legacy.txt");
    expect(entry?.encrypted).toBe(true);
    expect(entry?.encryptionMethod).toBe("zipcrypto");
    expect(new TextDecoder().decode(await archive.readEntry(entry!, {
      checkCrc: true,
      password: "swordfish",
    }))).toBe("legacy secret\n");
    expect(await readStreamText(archive.streamEntry(entry!, {
      checkCrc: true,
      chunkSize: 5,
      password: "swordfish",
    }))).toBe("legacy secret\n");
    await expect(archive.readEntry(entry!, { checkCrc: true })).rejects.toThrow(
      "requires a password",
    );
    await expect(archive.readEntry(entry!, {
      checkCrc: true,
      password: "wrong",
    })).rejects.toThrow("wrong password");
  });

  test("reads WinZip AES encrypted entries", async () => {
    const archive = ZipArchive.fromBuffer(aesZipFixture(), "aes.zip");
    const [entry] = await archive.entries();

    expect(entry?.path).toBe("aes.txt");
    expect(entry?.encrypted).toBe(true);
    expect(entry?.encryptionMethod).toBe("aes");
    expect(entry?.rawCompressionMethod).toBe(99);
    expect(entry?.compressionMethod).toBe(0);
    expect(new TextDecoder().decode(await archive.readEntry(entry!, {
      checkCrc: true,
      password: "open-sesame",
    }))).toBe("aes secret\n");
    expect(await readStreamText(archive.streamEntry(entry!, {
      checkCrc: true,
      chunkSize: 7,
      password: "open-sesame",
    }))).toBe("aes secret\n");
    await expect(archive.readEntry(entry!, { checkCrc: true })).rejects.toThrow(
      "requires a password",
    );
    await expect(archive.readEntry(entry!, {
      checkCrc: true,
      password: "wrong",
    })).rejects.toThrow("wrong AES ZIP password");
  });

  test("reads WinZip AES entries across multiple CTR blocks", async () => {
    const archive = ZipArchive.fromBuffer(aesLongZipFixture(), "long-aes.zip");
    const [entry] = await archive.entries();
    const expected = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n";

    expect(entry?.path).toBe("long.txt");
    expect((entry?.compressedSize ?? 0) - 16 - 2 - 10).toBeGreaterThan(16);
    expect(new TextDecoder().decode(await archive.readEntry(entry!, {
      checkCrc: true,
      password: "open-sesame",
    }))).toBe(expected);
    expect(await readStreamText(archive.streamEntry(entry!, {
      checkCrc: true,
      chunkSize: 9,
      password: "open-sesame",
    }))).toBe(expected);
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

async function readStreamText(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.byteLength;
  }

  const output = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }

  return new TextDecoder().decode(output);
}

function unixDeviceExtra(major: number, minor: number): Uint8Array {
  const bytes = new Uint8Array(4 + 20);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(0, 0x000d, true);
  view.setUint16(2, 20, true);
  view.setUint32(4, 0, true);
  view.setUint32(8, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, major, true);
  view.setUint32(20, minor, true);
  return bytes;
}
