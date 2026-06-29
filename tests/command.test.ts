import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aesZipFixture, makeZip, zipCryptoFixture } from "./zip-fixtures.ts";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");
const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0);

  await Promise.all(
    dirs.map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("pickarc commands", () => {
  test("ls applies ordered path operations and sorts final paths", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "src/b.txt", data: "bravo" },
      { path: "docs/c.txt", data: "charlie" },
      { path: "src/a.txt", data: "alpha" },
    ]);

    const result = await runPickarc(
      [
        "ls",
        "--include",
        "^src/",
        "--replace",
        "^src/(.*)$",
        "out/$1",
        archive,
      ],
      directory,
    );

    expectExitCode(result, 0);
    expect(result.stdout).toBe("out/a.txt\nout/b.txt\n");
  });

  test("cat writes selected file contents to stdout", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "a.txt", data: "alpha" },
      { path: "b.txt", data: "bravo" },
    ]);

    const result = await runPickarc(["cat", "--include", "^b\\.txt$", archive], directory);

    expectExitCode(result, 0);
    expect(result.stdout).toBe("bravo");
  });

  test("cat reads encrypted entries with password env sources", async () => {
    const directory = await makeTempDir();
    const archive = await writeBytes(directory, "legacy.zip", zipCryptoFixture());

    const result = await runPickarc(["cat", "--password-env", "PICKARC_PASSWORD", archive], directory, {
      PICKARC_PASSWORD: "swordfish",
    });

    expectExitCode(result, 0);
    expect(result.stdout).toBe("legacy secret\n");
  });

  test("cp reads encrypted entries with final-path password rules", async () => {
    const directory = await makeTempDir();
    const passwordFile = path.join(directory, "password.txt");
    const archive = await writeBytes(directory, "aes.zip", aesZipFixture());
    await writeFile(passwordFile, "open-sesame\n");

    const result = await runPickarc(
      [
        "cp",
        "--password-file-for-glob",
        "out/*.txt",
        passwordFile,
        "--replace",
        "^(.*)$",
        "out/$1",
        archive,
      ],
      directory,
    );

    expectExitCode(result, 0);
    expect(await readText(path.join(directory, "out/aes.txt"))).toBe("aes secret\n");
  });

  test("stat reports encrypted entry metadata", async () => {
    const directory = await makeTempDir();
    const archive = await writeBytes(directory, "aes.zip", aesZipFixture());

    const result = await runPickarc(["stat", "--json", archive], directory);
    const entries = JSON.parse(result.stdout);

    expectExitCode(result, 0);
    expect(entries[0]).toMatchObject({
      path: "aes.txt",
      encrypted: true,
      encryptionMethod: "aes",
      rawCompressionMethod: 99,
      compressionMethod: 0,
    });
  });

  test("ls supports glob include OR groups", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/a.h", data: "a" },
      { path: "toolchains/llvm/prebuilt/linux-x86_64/lib/clang/21/lib/linux/b.a", data: "b" },
      { path: "toolchains/llvm/prebuilt/linux-x86_64/lib/clang/21/include/c.h", data: "c" },
      { path: "toolchains/llvm/prebuilt/linux-x86_64/bin/clang", data: "clang" },
    ]);

    const result = await runPickarc(
      [
        "ls",
        "--include-glob",
        "toolchains/llvm/prebuilt/linux-x86_64/sysroot/**",
        "--or-glob",
        "toolchains/llvm/prebuilt/linux-x86_64/lib/clang/*/lib/linux/**",
        "--or-glob",
        "toolchains/llvm/prebuilt/linux-x86_64/lib/clang/*/include/**",
        archive,
      ],
      directory,
    );

    expectExitCode(result, 0);
    expect(result.stdout).toBe(
      [
        "toolchains/llvm/prebuilt/linux-x86_64/lib/clang/21/include/c.h",
        "toolchains/llvm/prebuilt/linux-x86_64/lib/clang/21/lib/linux/b.a",
        "toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/a.h",
        "",
      ].join("\n"),
    );
  });

  test("du reports aggregate metadata without reading file contents", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "dir/" },
      { path: "dir/a.txt", data: "alpha" },
      { path: "dir/sub/b.txt", data: "bravo!" },
    ]);

    const result = await runPickarc(["du", "--bytes", archive], directory);
    const rows = whitespaceRows(result.stdout);

    expectExitCode(result, 0);
    expect(rows).toEqual([
      ["compressed", "uncompressed", "files", "dirs", "entries"],
      ["11", "11", "2", "1", "3"],
    ]);
  });

  test("du can group recursive totals by directory", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "dir/" },
      { path: "dir/a.txt", data: "alpha" },
      { path: "dir/sub/b.txt", data: "bravo!" },
    ]);

    const result = await runPickarc(["du", "--bytes", "--by", "dir", "--depth", "1", archive], directory);
    const rows = whitespaceRows(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(rows).toEqual([
      ["compressed", "uncompressed", "files", "dirs", "entries", "path"],
      ["11", "11", "2", "1", "3", "."],
      ["11", "11", "2", "1", "3", "dir"],
    ]);
  });

  test("du supports JSON output", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "a.txt", data: "alpha" },
      { path: "b.txt", data: "bravo!" },
    ]);

    const result = await runPickarc(["du", "--json", archive], directory);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      files: 2,
      directories: 0,
      entries: 2,
      compressedSize: 11,
      uncompressedSize: 11,
      archives: 1,
    });
  });

  test("stat reports per-entry metadata as JSON and JSONL", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "a.txt", data: "alpha" },
      { path: "dir/" },
    ]);

    const jsonResult = await runPickarc(["stat", "--json", archive], directory);
    const entries = JSON.parse(jsonResult.stdout);

    expect(jsonResult.exitCode).toBe(0);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      path: "a.txt",
      sourcePath: "a.txt",
      kind: "file",
      compressionMethod: 0,
      compressionName: "store",
      compressedSize: 5,
      uncompressedSize: 5,
      isSymlink: false,
      isSpecialFile: false,
    });
    expect(entries[0].crc32).toMatch(/^[0-9a-f]{8}$/);

    const jsonlResult = await runPickarc(["stat", "--jsonl", "--include", "^a\\.txt$", archive], directory);
    const lines = jsonlResult.stdout.trim().split("\n");

    expect(jsonlResult.exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).path).toBe("a.txt");
  });

  test("metadata output flags are rejected for path-only commands", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [{ path: "a.txt", data: "alpha" }]);

    const result = await runPickarc(["ls", "--json", archive], directory);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("metadata output options");
  });

  test("cp skips checksum only by final path", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "bad.txt", data: "bad", crc32: 0 },
      { path: "ok.txt", data: "ok" },
    ]);

    const result = await runPickarc(
      [
        "cp",
        "--ignore-checksum",
        "^out/bad\\.txt$",
        "--replace",
        "^(.*)$",
        "out/$1",
        archive,
      ],
      directory,
    );

    expectExitCode(result, 0);
    expect(await readText(path.join(directory, "out/bad.txt"))).toBe("bad");
    expect(await readText(path.join(directory, "out/ok.txt"))).toBe("ok");
  });

  test("cp fails CRC checks before writing", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "bad.txt", data: "bad", crc32: 0 },
    ]);

    const result = await runPickarc(["cp", archive], directory);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CRC32 mismatch");
    await expect(stat(path.join(directory, "bad.txt"))).rejects.toThrow();
  });

  test("cp refuses ZIP special file entries", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "pipe", externalAttributes: 0o010644 << 16 },
      { path: "link", data: "target.txt", externalAttributes: 0o120777 << 16 },
    ]);

    const result = await runPickarc(["cp", archive], directory);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("special file");
    await expect(stat(path.join(directory, "pipe"))).rejects.toThrow();
    await expect(lstat(path.join(directory, "link"))).rejects.toThrow();
  });

  test("cp extracts ZIP symlink entries only when allowed", async () => {
    if (process.platform === "win32") {
      return;
    }

    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "target.txt", data: "target" },
      { path: "link", data: "target.txt", externalAttributes: 0o120777 << 16 },
    ]);

    const result = await runPickarc(
      ["cp", "--allow-special-file-types", "symlink", archive],
      directory,
    );

    expectExitCode(result, 0);
    expect((await lstat(path.join(directory, "link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(directory, "link"))).toBe("target.txt");
  });

  test("cp extracts ZIP FIFO entries only when allowed", async () => {
    if (process.platform === "win32") {
      return;
    }

    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "pipe", externalAttributes: 0o010644 << 16 },
    ]);

    const result = await runPickarc(
      ["cp", "--allow-special-file-types", "fifo", archive],
      directory,
    );

    expectExitCode(result, 0);
    expect((await lstat(path.join(directory, "pipe"))).isFIFO()).toBe(true);
  });

  test("cp extracts ZIP socket entries only when allowed", async () => {
    if (process.platform === "win32") {
      return;
    }

    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "sock", externalAttributes: 0o140755 << 16 },
    ]);

    const result = await runPickarc(
      ["cp", "--allow-special-file-types", "socket", archive],
      directory,
    );

    expectExitCode(result, 0);
    expect((await lstat(path.join(directory, "sock"))).isSocket()).toBe(true);
  });

  test("cp requires device numbers for ZIP device entries", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "null", externalAttributes: 0o020666 << 16 },
    ]);

    const result = await runPickarc(
      ["cp", "--allow-special-file-types", "char-device", archive],
      directory,
    );

    expectExitCode(result, 1);
    expect(result.stderr).toContain("missing device numbers");
  });

  test("cp applies owner permissions by default", async () => {
    if (process.platform === "win32") {
      return;
    }

    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "bin/", externalAttributes: 0o040775 << 16 },
      { path: "bin/tool", data: "tool", externalAttributes: 0o100775 << 16 },
      { path: "world.txt", data: "world", externalAttributes: 0o100666 << 16 },
    ]);

    const result = await runPickarc(
      ["cp", "--replace", "^(.*)$", "owner/$1", archive],
      directory,
    );

    expect(result.exitCode).toBe(0);
    expect(await modeOf(path.join(directory, "owner/bin"))).toBe(0o700);
    expect(await modeOf(path.join(directory, "owner/bin/tool"))).toBe(0o700);
    expect(await modeOf(path.join(directory, "owner/world.txt"))).toBe(0o600);
  });

  test("cp supports preserve, sanitize, and private permission policies", async () => {
    if (process.platform === "win32") {
      return;
    }

    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "bin/", externalAttributes: 0o040777 << 16 },
      { path: "bin/tool", data: "tool", externalAttributes: 0o100777 << 16 },
      { path: "world.txt", data: "world", externalAttributes: 0o100666 << 16 },
    ]);

    const preserve = await runPickarc(
      ["cp", "--permissions", "preserve", "--replace", "^(.*)$", "preserve/$1", archive],
      directory,
    );
    const sanitize = await runPickarc(
      ["cp", "--permissions", "sanitize", "--replace", "^(.*)$", "sanitize/$1", archive],
      directory,
    );
    const privateMode = await runPickarc(
      ["cp", "--permissions", "private", "--replace", "^(.*)$", "private/$1", archive],
      directory,
    );

    expect(preserve.exitCode).toBe(0);
    expect(sanitize.exitCode).toBe(0);
    expect(privateMode.exitCode).toBe(0);
    expect(await modeOf(path.join(directory, "preserve/bin"))).toBe(0o777);
    expect(await modeOf(path.join(directory, "preserve/bin/tool"))).toBe(0o777);
    expect(await modeOf(path.join(directory, "preserve/world.txt"))).toBe(0o666);
    expect(await modeOf(path.join(directory, "sanitize/bin"))).toBe(0o755);
    expect(await modeOf(path.join(directory, "sanitize/bin/tool"))).toBe(0o755);
    expect(await modeOf(path.join(directory, "sanitize/world.txt"))).toBe(0o644);
    expect(await modeOf(path.join(directory, "private/bin"))).toBe(0o700);
    expect(await modeOf(path.join(directory, "private/bin/tool"))).toBe(0o600);
    expect(await modeOf(path.join(directory, "private/world.txt"))).toBe(0o600);
  });

  test("cp drops special mode bits unless explicitly preserved", async () => {
    if (process.platform === "win32") {
      return;
    }

    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "sticky/", externalAttributes: 0o041777 << 16 },
    ]);

    const dropped = await runPickarc(
      ["cp", "--permissions", "preserve", "--replace", "^(.*)$", "dropped/$1", archive],
      directory,
    );
    const preserved = await runPickarc(
      [
        "cp",
        "--permissions",
        "preserve",
        "--preserve-special-mode",
        "sticky",
        "--replace",
        "^(.*)$",
        "preserved/$1",
        archive,
      ],
      directory,
    );

    expect(dropped.exitCode).toBe(0);
    expect(preserved.exitCode).toBe(0);
    expect(await modeOf(path.join(directory, "dropped/sticky"))).toBe(0o777);
    expect(await modeOf(path.join(directory, "preserved/sticky"))).toBe(0o1777);
  });

  test("cp can render forced progress with bold labels and cyan bars", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [{ path: "file.txt", data: "body" }]);

    const result = await runPickarc(["cp", "--progress", "always", archive], directory, {
      FORCE_COLOR: "1",
      NO_COLOR: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("\x1b[1mfile.txt\x1b[0m");
    expect(result.stderr).toContain("\x1b[36m");
    expect(result.stderr).toContain("total");
    expect(await readText(path.join(directory, "file.txt"))).toBe("body");
  });

  test("cp can disable progress explicitly", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [{ path: "file.txt", data: "body" }]);

    const result = await runPickarc(["cp", "--progress", "never", archive], directory, {
      FORCE_COLOR: "1",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("expands stored nested zip entries as directories", async () => {
    const directory = await makeTempDir();
    const inner = makeZip([{ path: "file.txt", data: "inner" }]);
    const archive = await writeZip(directory, "outer.zip", [
      { path: "nested.zip", data: inner, method: 0 },
    ]);

    const result = await runPickarc(["ls", "--as-dir", "\\.zip$", archive], directory);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("nested/file.txt\n");
  });

  test("as-dir aborts for compressed nested zip entries", async () => {
    const directory = await makeTempDir();
    const inner = makeZip([{ path: "file.txt", data: "inner" }]);
    const archive = await writeZip(directory, "outer.zip", [
      { path: "nested.zip", data: inner, method: 8 },
    ]);

    const result = await runPickarc(["ls", "--as-dir", "\\.zip$", archive], directory);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requires ZIP compression method 0");
  });

  test("cp permits absolute outputs only through replacement and supports lockdown", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [{ path: "file.txt", data: "body" }]);
    const resolvedDirectory = await realpath(directory);
    const absoluteTarget = path.join(resolvedDirectory, "absolute.txt");

    const absoluteResult = await runPickarc(
      [
        "cp",
        "--replace",
        "^file\\.txt$",
        absoluteTarget,
        archive,
      ],
      directory,
    );

    expectExitCode(absoluteResult, 0);
    expect(await readText(absoluteTarget)).toBe("body");

    const lockdownRoot = path.join(directory, "lock");
    await mkdir(lockdownRoot);

    const lockdownResult = await runPickarc(
      [
        "cp",
        "--lockdown",
        lockdownRoot,
        "--replace",
        "^file\\.txt$",
        path.join(directory, "outside.txt"),
        archive,
      ],
      directory,
    );

    expectExitCode(lockdownResult, 1);
    expect(lockdownResult.stderr).toContain("escapes lockdown");
  });

  test("cp refuses to overwrite existing files", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [{ path: "file.txt", data: "body" }]);
    await writeFile(path.join(directory, "file.txt"), "existing");

    const result = await runPickarc(["cp", archive], directory);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("refused to overwrite");
  });
});

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pickarc-"));
  tempDirs.push(directory);
  return directory;
}

function expectExitCode(
  result: {
    stdout: string;
    stderr: string;
    exitCode: number;
  },
  expected: number,
): void {
  if (result.exitCode !== expected) {
    throw new Error(
      [
        `expected exit code ${expected}, received ${result.exitCode}`,
        "stdout:",
        result.stdout,
        "stderr:",
        result.stderr,
      ].join("\n"),
    );
  }
}

async function writeZip(
  directory: string,
  name: string,
  entries: Parameters<typeof makeZip>[0],
): Promise<string> {
  const archive = path.join(directory, name);
  await Bun.write(archive, makeZip(entries));
  return archive;
}

async function writeBytes(directory: string, name: string, bytes: Uint8Array): Promise<string> {
  const archive = path.join(directory, name);
  await Bun.write(archive, bytes);
  return archive;
}

async function runPickarc(
  args: readonly string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const process = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
    env: mergeEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  return {
    stdout,
    stderr,
    exitCode,
  };
}

async function readText(file: string): Promise<string> {
  return new TextDecoder().decode(await readFile(file));
}

async function modeOf(file: string): Promise<number> {
  return (await stat(file)).mode & 0o7777;
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

function mergeEnv(overrides: Record<string, string | undefined> | undefined): Record<string, string> {
  const env = processEnv();

  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
}

function whitespaceRows(output: string): string[][] {
  return output
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/));
}
