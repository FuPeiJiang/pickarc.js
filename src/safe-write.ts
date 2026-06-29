import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { fail } from "./errors.ts";

const windowsAbsolutePath = /^[A-Za-z]:\//;
const initialFileMode = 0o600;
const initialDirectoryMode = 0o700;

export interface ResolvedOutputPath {
  target: string;
  lockdownRoot: string | undefined;
}

export interface SafeWriteResult {
  createdDirectories: string[];
}

export interface CreateDirectoryResult extends SafeWriteResult {
  target: string;
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
  mode: number,
): Promise<SafeWriteResult> {
  const { target, lockdownRoot } = await resolveOutputPath(finalPath, lockdown);
  const createdDirectories = await ensureDirectory(path.dirname(target), lockdownRoot);

  let handle;

  try {
    handle = await open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      initialFileMode,
    );
  } catch (error) {
    failOpen(target, error);
  }

  try {
    await handle.writeFile(data);
    await chmodOpenHandle(handle, mode);
  } finally {
    await handle.close();
  }

  return {
    createdDirectories,
  };
}

export async function writeFileExclusiveStream(
  finalPath: string,
  chunks: AsyncIterable<Uint8Array>,
  lockdown: string | undefined,
  mode: number,
  onChunk?: (bytes: number) => void,
): Promise<SafeWriteResult> {
  const { target, lockdownRoot } = await resolveOutputPath(finalPath, lockdown);
  const createdDirectories = await ensureDirectory(path.dirname(target), lockdownRoot);

  let handle;
  let completed = false;

  try {
    handle = await open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      initialFileMode,
    );
  } catch (error) {
    failOpen(target, error);
  }

  try {
    for await (const chunk of chunks) {
      await writeAll(handle, chunk);
      onChunk?.(chunk.byteLength);
    }

    await chmodOpenHandle(handle, mode);
    completed = true;
  } finally {
    await handle.close();

    if (!completed) {
      await unlink(target).catch(() => undefined);
    }
  }

  return {
    createdDirectories,
  };
}

export async function createDirectory(
  finalPath: string,
  lockdown: string | undefined,
): Promise<CreateDirectoryResult> {
  const { target, lockdownRoot } = await resolveOutputPath(finalPath, lockdown);
  return {
    target,
    createdDirectories: await ensureDirectory(target, lockdownRoot),
  };
}

export async function chmodCreatedDirectory(target: string, mode: number): Promise<void> {
  const info = await lstat(target);

  if (info.isSymbolicLink()) {
    fail(`${target}: refused symlinked directory during chmod`);
  }

  if (!info.isDirectory()) {
    fail(`${target}: expected a directory during chmod`);
  }

  const flags = process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let handle;

  try {
    handle = await open(target, flags);
  } catch (error) {
    failOpen(target, error);
  }

  try {
    await chmodOpenHandle(handle, mode);
  } finally {
    await handle.close();
  }
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

async function ensureDirectory(directory: string, lockdownRoot: string | undefined): Promise<string[]> {
  if (lockdownRoot !== undefined && !isWithin(lockdownRoot, directory)) {
    fail(`${directory}: directory escapes lockdown root ${lockdownRoot}`);
  }

  const createdDirectories: string[] = [];
  const root = path.parse(directory).root;
  const relative = path.relative(root, directory);
  let current = root;

  if (relative === "") {
    return createdDirectories;
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
        await mkdir(current, { mode: initialDirectoryMode }).catch((mkdirError: unknown) => {
          if (!isAlreadyExists(mkdirError)) {
            throw mkdirError;
          }
        });
        const info = await lstat(current);

        if (info.isSymbolicLink() || !info.isDirectory()) {
          fail(`${current}: failed to create safe directory`);
        }

        createdDirectories.push(current);
        continue;
      }

      throw error;
    }
  }

  return createdDirectories;
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

async function chmodOpenHandle(
  handle: Awaited<ReturnType<typeof open>>,
  mode: number,
): Promise<void> {
  if ((mode & 0o7000) === 0 || process.platform === "win32") {
    await handle.chmod(mode);
    return;
  }

  if (process.platform !== "linux") {
    await handle.chmod(mode);
    return;
  }

  const fdPath = `/proc/${process.pid}/fd/${handle.fd}`;
  const child = Bun.spawn(["chmod", mode.toString(8), fdPath], {
    stderr: "pipe",
    stdout: "ignore",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exitCode !== 0) {
    fail(`chmod ${mode.toString(8)}: ${stderr.trim() || `exited with code ${exitCode}`}`);
  }
}
