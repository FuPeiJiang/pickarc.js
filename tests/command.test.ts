import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeZip } from "./zip-fixtures.ts";

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

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("out/a.txt\nout/b.txt\n");
  });

  test("cat writes selected file contents to stdout", async () => {
    const directory = await makeTempDir();
    const archive = await writeZip(directory, "fixture.zip", [
      { path: "a.txt", data: "alpha" },
      { path: "b.txt", data: "bravo" },
    ]);

    const result = await runPickarc(["cat", "--include", "^b\\.txt$", archive], directory);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("bravo");
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

    expect(result.exitCode).toBe(0);
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
    const absoluteTarget = path.join(directory, "absolute.txt");

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

    expect(absoluteResult.exitCode).toBe(0);
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

    expect(lockdownResult.exitCode).toBe(1);
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

async function writeZip(
  directory: string,
  name: string,
  entries: Parameters<typeof makeZip>[0],
): Promise<string> {
  const archive = path.join(directory, name);
  await Bun.write(archive, makeZip(entries));
  return archive;
}

async function runPickarc(
  args: readonly string[],
  cwd: string,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const process = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
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
