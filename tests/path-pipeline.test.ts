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
      "--archive-is-dir-glob",
      "**/*.zip",
      "--archive-is-dir-keep-ext-glob",
      "**/*.cbz",
      "--cut-prefix",
      "1",
      "--strip-components",
      "2",
      "archive.zip",
    ]);

    expect(parsed.operations.map((operation) => operation.kind)).toEqual([
      "as-dir",
      "as-dir",
      "as-dir",
      "as-dir",
      "strip-components",
      "strip-components",
    ]);
  });

  test("parses progress options", () => {
    expect(parseArgs(["cp", "--progress", "always", "archive.zip"]).progress).toBe("always");
    expect(parseArgs(["cp", "--no-progress", "archive.zip"]).progress).toBe("never");
    expect(() => parseArgs(["cp", "--progress", "sometimes", "archive.zip"])).toThrow(
      "expected auto, always, or never",
    );
  });

  test("parses jobs option", () => {
    expect(parseArgs(["cp", "--jobs", "8", "archive.zip"]).jobs).toBe(8);
    expect(parseArgs(["cp", "archive.zip"]).jobs).toBe(1);
    expect(() => parseArgs(["cp", "--jobs", "0", "archive.zip"])).toThrow(
      "expected a positive integer",
    );
  });

  test("parses http transport options", () => {
    expect(parseArgs(["ls", "--http", "http1", "archive.zip"]).httpTransport).toBe("http1");
    expect(parseArgs(["ls", "--http", "http2", "archive.zip"]).httpTransport).toBe("http2");
    expect(parseArgs(["ls", "archive.zip"]).httpTransport).toBe("fetch");
    expect(() => parseArgs(["ls", "--http", "http3", "archive.zip"])).toThrow(
      "expected fetch, http1, or http2",
    );
  });

  test("parses metadata output options", () => {
    const parsed = parseArgs([
      "du",
      "--json",
      "--bytes",
      "--by",
      "dir",
      "--depth",
      "2",
      "archive.zip",
    ]);

    expect(parsed.json).toBe(true);
    expect(parsed.bytes).toBe(true);
    expect(parsed.groupBy).toBe("dir");
    expect(parsed.depth).toBe(2);
    expect(() => parseArgs(["du", "--by", "owner", "archive.zip"])).toThrow(
      "expected none, archive, or dir",
    );
  });

  test("supports regex and glob OR groups for includes", async () => {
    const parsed = parseArgs([
      "ls",
      "--include-glob",
      "src/**/*.txt",
      "--or",
      "^docs/.*\\.md$",
      "--or-glob",
      "images/**/*.img",
      "archive.zip",
    ]);

    const paths = await prepareFinalCandidates(
      [
        candidate("src/a.txt"),
        candidate("src/nested/b.txt"),
        candidate("docs/readme.md"),
        candidate("images/disk.img"),
        candidate("images/raw/disk.img"),
        candidate("vendor/a.txt"),
      ],
      parsed.operations,
    );

    expect(paths.map((entry) => entry.path)).toEqual([
      "docs/readme.md",
      "images/disk.img",
      "images/raw/disk.img",
      "src/a.txt",
      "src/nested/b.txt",
    ]);
  });

  test("starts a new include group for each include option", async () => {
    const parsed = parseArgs([
      "ls",
      "--include-glob",
      "src/**",
      "--or-glob",
      "docs/**",
      "--include",
      "\\.txt$",
      "archive.zip",
    ]);

    const paths = await prepareFinalCandidates(
      [
        candidate("src/a.txt"),
        candidate("src/a.md"),
        candidate("docs/b.txt"),
        candidate("docs/b.md"),
      ],
      parsed.operations,
    );

    expect(paths.map((entry) => entry.path)).toEqual(["docs/b.txt", "src/a.txt"]);
  });

  test("supports glob excludes", async () => {
    const parsed = parseArgs([
      "ls",
      "--include-glob",
      "**/*.txt",
      "--exclude-glob",
      "**/vendor/**",
      "archive.zip",
    ]);

    const paths = await prepareFinalCandidates(
      [
        candidate("src/a.txt"),
        candidate("src/vendor/b.txt"),
        candidate("vendor/c.txt"),
      ],
      parsed.operations,
    );

    expect(paths.map((entry) => entry.path)).toEqual(["src/a.txt"]);
  });

  test("requires --or to follow an include group", () => {
    expect(() => parseArgs(["ls", "--or", "x", "archive.zip"])).toThrow(
      "expected a preceding",
    );
    expect(() =>
      parseArgs(["ls", "--include", "x", "--exclude", "y", "--or", "z", "archive.zip"]),
    ).toThrow("expected a preceding");
  });

  test("uses glob matchers for as-dir", async () => {
    const parsed = parseArgs(["ls", "--as-dir-glob", "**/*.zip", "archive.zip"]);
    const expanded = await prepareFinalCandidates(
      [candidate("nested/data.zip"), candidate("nested/data.txt")],
      parsed.operations,
      async (entry) => [
        {
          ...entry,
          id: `${entry.id}:expanded`,
          path: `${entry.path}/file.txt`,
          sourcePath: `${entry.sourcePath}!file.txt`,
        },
      ],
    );

    expect(expanded.map((entry) => entry.path)).toEqual([
      "nested/data.txt",
      "nested/data.zip/file.txt",
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
    crc32: 0,
    compressedSize: 0,
    uncompressedSize: 0,
    physicalOffset: undefined,
    absoluteFromReplace: false,
    isSymlink: false,
    readData: async (_options) => {
      throw new Error("content should not be read");
    },
    streamData: async function* (_options) {
      throw new Error("content should not be read");
    },
    planRange: () => undefined,
    dataRange: async () => undefined,
    primeRange: async (_offset, _length) => {},
  };
}
