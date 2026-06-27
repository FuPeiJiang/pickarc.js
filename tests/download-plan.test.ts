import { describe, expect, test } from "bun:test";
import { planCopyOrder } from "../src/commands.ts";
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
});

function candidate(
  path: string,
  archiveLabel: string,
  physicalOffset: number | undefined,
  kind: "file" | "directory" = "file",
): PathCandidate {
  return {
    id: `${archiveLabel}:${path}`,
    archiveLabel,
    sourcePath: path,
    path,
    kind,
    compressionMethod: 0,
    uncompressedSize: 0,
    physicalOffset,
    absoluteFromReplace: false,
    isSymlink: false,
    readData: async () => new Uint8Array(),
    streamData: async function* () {
      yield new Uint8Array();
    },
  };
}
