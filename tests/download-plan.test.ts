import { describe, expect, test } from "bun:test";
import { buildCopyGroups, planCopyOrder } from "../src/commands.ts";
import type { PathCandidate } from "../src/path-pipeline.ts";

describe("copy download plan", () => {
  test("keeps directories first and orders files by archive physical offset", () => {
    const planned = planCopyOrder([
      candidate("b.txt", "archive.zip", 200),
      candidate("dir", "archive.zip", undefined, "directory"),
      candidate("a.txt", "archive.zip", 100),
      candidate("other.txt", "other.zip", 50),
    ]);

    expect(planned.map((entry) => entry.path)).toEqual([
      "dir",
      "a.txt",
      "b.txt",
      "other.txt",
    ]);
  });

  test("builds bounded merged compressed range groups", async () => {
    const groups = await buildCopyGroups([
      candidate("c.txt", "archive.zip", 300, "file", {
        offset: 300,
        length: 20,
      }),
      candidate("a.txt", "archive.zip", 100, "file", {
        offset: 100,
        length: 50,
      }),
      candidate("b.txt", "archive.zip", 160, "file", {
        offset: 160,
        length: 50,
      }),
      candidate("huge.bin", "archive.zip", 1000, "file", {
        offset: 1000,
        length: 33 * 1024 * 1024,
      }),
    ]);

    expect(
      groups.map((group) => ({
        paths: group.files.map((file) => file.path),
        range: group.range,
      })),
    ).toEqual([
      {
        paths: ["a.txt", "b.txt", "c.txt"],
        range: {
          offset: 100,
          length: 220,
        },
      },
      {
        paths: ["huge.bin"],
        range: undefined,
      },
    ]);
  });
});

function candidate(
  path: string,
  archiveLabel: string,
  physicalOffset: number | undefined,
  kind: "file" | "directory" = "file",
  dataRange?: { offset: number; length: number },
): PathCandidate {
  return {
    id: `${archiveLabel}:${path}`,
    archiveLabel,
    sourcePath: path,
    path,
    kind,
    compressionMethod: 0,
    compressedSize: 0,
    uncompressedSize: 0,
    physicalOffset,
    absoluteFromReplace: false,
    isSymlink: false,
    readData: async () => new Uint8Array(),
    streamData: async function* () {
      yield new Uint8Array();
    },
    dataRange: async () => dataRange,
    primeRange: async () => {},
  };
}
