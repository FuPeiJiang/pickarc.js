import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { fail } from "./errors.ts";

const windowsAbsolutePath = /^[A-Za-z]:\//;

export interface ResolvedOutputPath {
  target: string;
  lockdownRoot: string | undefined;
}

export async function resolveOutputPath(
  finalPath: string,
  lockdown: string | undefined,
): Promise<ResolvedOutputPath> {
  if (windowsAbsolutePath.test(finalPath) && process.platform !== "win32") {
    fail(`${finalPath}: Windows absolute output paths are not writable on this platform`);
  }

  const target = path.isAbsolute(finalPath)
    ? path.resolve(finalPath)
    : path.resolve(process.cwd(), finalPath);
  const lockdownRoot = lockdown === undefined ? undefined : await resolveLockdownRoot(lockdown);

  if (lockdownRoot !== undefined && !isWithin(lockdownRoot, target)) {
    fail(`${finalPath}: output path escapes lockdown root ${lockdownRoot}`);
  }

  return {
    target,
    lockdownRoot,
  };
}

export async function writeFileExclusive(
  finalPath: string,
  data: Uint8Array,
  lockdown: string | undefined,
): Promise<void> {
  const { target, lockdownRoot } = await resolveOutputPath(finalPath, lockdown);
  await ensureDirectory(path.dirname(target), lockdownRoot);

  let handle;

  try {
    handle = await open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    failOpen(target, error);
  }

  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

export async function writeFileExclusiveStream(
  finalPath: string,
  chunks: AsyncIterable<Uint8Array>,
  lockdown: string | undefined,
  onChunk?: (bytes: number) => void,
): Promise<void> {
  const { target, lockdownRoot } = await resolveOutputPath(finalPath, lockdown);
  await ensureDirectory(path.dirname(target), lockdownRoot);

  let handle;
  let completed = false;

  try {
    handle = await open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    failOpen(target, error);
  }

  try {
    for await (const chunk of chunks) {
      await writeAll(handle, chunk);
      onChunk?.(chunk.byteLength);
    }

    completed = true;
  } finally {
    await handle.close();

    if (!completed) {
      await unlink(target).catch(() => undefined);
    }
  }
}

export async function createDirectory(finalPath: string, lockdown: string | undefined): Promise<void> {
  const { target, lockdownRoot } = await resolveOutputPath(finalPath, lockdown);
  await ensureDirectory(target, lockdownRoot);
}

async function resolveLockdownRoot(lockdown: string): Promise<string> {
  const root = path.resolve(lockdown);
  let info;

  try {
    info = await lstat(root);
  } catch (error) {
    failOpen(root, error);
  }

  if (info.isSymbolicLink()) {
    fail(`${root}: lockdown root must not be a symlink`);
  }

  if (!info.isDirectory()) {
    fail(`${root}: lockdown root must be a directory`);
  }

  return root;
}

async function ensureDirectory(directory: string, lockdownRoot: string | undefined): Promise<void> {
  if (lockdownRoot !== undefined && !isWithin(lockdownRoot, directory)) {
    fail(`${directory}: directory escapes lockdown root ${lockdownRoot}`);
  }

  const root = path.parse(directory).root;
  const relative = path.relative(root, directory);
  let current = root;

  if (relative === "") {
    return;
  }

  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);

    try {
      const info = await lstat(current);

      if (info.isSymbolicLink()) {
        fail(`${current}: refused symlinked parent directory`);
      }

      if (!info.isDirectory()) {
        fail(`${current}: expected a directory`);
      }
    } catch (error) {
      if (isNotFound(error)) {
        await mkdir(current, { mode: 0o700 }).catch((mkdirError: unknown) => {
          if (!isAlreadyExists(mkdirError)) {
            throw mkdirError;
          }
        });
        const info = await lstat(current);

        if (info.isSymbolicLink() || !info.isDirectory()) {
          fail(`${current}: failed to create safe directory`);
        }

        continue;
      }

      throw error;
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function failOpen(target: string, error: unknown): never {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

  if (code === "EEXIST") {
    fail(`${target}: refused to overwrite existing path`);
  }

  if (code === "ELOOP") {
    fail(`${target}: refused symlink output path`);
  }

  if (code === "ENOENT") {
    fail(`${target}: path does not exist`);
  }

  fail(`${target}: ${String(error)}`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;

  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
    offset += result.bytesWritten;
  }
}
