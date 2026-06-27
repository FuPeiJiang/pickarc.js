import { describe, expect, test } from "bun:test";
import { PickarcError } from "../src/errors.ts";
import { parseArgs } from "../src/options.ts";
import type { PathCandidate } from "../src/path-pipeline.ts";
import { prepareFinalCandidates } from "../src/path-pipeline.ts";
import { normalizeArchivePath } from "../src/path-utils.ts";

describe("path pipeline", () => {
  test("runs filters and rewrites in command-line order", async () => {
    const parsed = parseArgs([
      "ls",
      "--include",
      "^src/",
      "--replace",
      "^src/(.*)$",
      "lib/$1",
      "--exclude",
      "skip",
      "archive.zip",
    ]);

    const paths = await prepareFinalCandidates(
      [
        candidate("src/a.txt"),
        candidate("src/skip.txt"),
        candidate("docs/a.txt"),
      ],
      parsed.operations,
    );

    expect(paths.map((entry) => entry.path)).toEqual(["lib/a.txt"]);
  });

  test("detects duplicate final paths before content reads", async () => {
    const parsed = parseArgs([
      "cp",
      "--flatten",
      "archive.zip",
    ]);

    await expect(
      prepareFinalCandidates(
        [
          candidate("a/file.txt"),
          candidate("b/file.txt"),
        ],
        parsed.operations,
      ),
    ).rejects.toThrow("duplicate final path");
  });

  test("allows absolute final paths only when --replace produced them", async () => {
    const parsed = parseArgs([
      "cp",
      "--replace",
      "^out/(.*)$",
      "/tmp/$1",
      "archive.zip",
    ]);

    const paths = await prepareFinalCandidates([candidate("out/file.txt")], parsed.operations);
    expect(paths[0]!.path).toBe("/tmp/file.txt");
  });

  test("refuses archive zip slip paths", () => {
    expect(() => normalizeArchivePath("safe/../evil.txt", "archive.zip")).toThrow(PickarcError);
  });

  test("parses path operation aliases", () => {
    const parsed = parseArgs([
      "ls",
      "--archive-is-dir",
      "\\.zip$",
      "--archive-is-dir-keep-ext",
      "\\.cbz$",
      "--cut-prefix",
      "1",
      "--strip-components",
      "2",
      "archive.zip",
    ]);

    expect(parsed.operations.map((operation) => operation.kind)).toEqual([
      "as-dir",
      "as-dir",
      "strip-components",
      "strip-components",
    ]);
  });
});

function candidate(path: string): PathCandidate {
  return {
    id: path,
    archiveLabel: "archive.zip",
    sourcePath: path,
    path,
    kind: "file",
    compressionMethod: 0,
    absoluteFromReplace: false,
    isSymlink: false,
    readData: async () => {
      throw new Error("content should not be read");
    },
  };
}
