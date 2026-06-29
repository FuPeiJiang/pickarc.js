import { collectArchiveCandidates, expandStoredZipAsDirectory } from "./archive.ts";
import { fail } from "./errors.ts";
import { diskUsage, statEntries } from "./metadata.ts";
import type { ParsedArgs } from "./options.ts";
import { PasswordResolver } from "./passwords.ts";
import { prepareFinalCandidates, type PathCandidate } from "./path-pipeline.ts";
import { isSpecialFileTypeAllowed, modeForCandidate } from "./permissions.ts";
import { CopyProgress } from "./progress.ts";
import {
  createDeviceExclusive,
  DirectoryEnsurer,
  createFifoExclusive,
  createSocketExclusive,
  createSymlinkExclusive,
  writeFileExclusive,
  writeFileExclusiveStream,
} from "./safe-write.ts";

export async function runCommand(options: ParsedArgs): Promise<void> {
  validateCommandOptions(options);
  const passwords = new PasswordResolver({
    fallback: options.password,
    rules: options.passwordRules,
  });

  const archiveSet = await collectArchiveCandidates(options.archives, {
    proxy: options.proxy,
    insecure: options.insecure,
  });

  try {
    const candidates = await prepareFinalCandidates(
      archiveSet.candidates,
      options.operations,
      expandStoredZipAsDirectory,
    );

    switch (options.command) {
      case "ls":
        await list(candidates);
        break;

      case "cat":
        await cat(candidates, options, passwords);
        break;

      case "cp":
        await copy(candidates, options, passwords);
        break;

      case "du":
        await diskUsage(candidates, options);
        break;

      case "stat":
        await statEntries(candidates, options);
        break;
    }
  } finally {
    await archiveSet.close();
  }
}

function validateCommandOptions(options: ParsedArgs): void {
  const hasMetadataOutputOption =
    options.json ||
    options.jsonl ||
    options.bytes ||
    options.groupBy !== "none" ||
    options.depth !== undefined ||
    options.all;

  if (
    options.command !== "du" &&
    options.command !== "stat" &&
    hasMetadataOutputOption
  ) {
    fail(`${options.command}: metadata output options are only supported by du and stat`);
  }

  if (
    options.command === "stat" &&
    (options.groupBy !== "none" || options.depth !== undefined || options.all)
  ) {
    fail(`stat: --by, --depth, and --all are only supported by du`);
  }

  if (options.command === "du" && options.jsonl) {
    fail(`du: --jsonl is only supported by stat`);
  }
}

async function list(candidates: readonly PathCandidate[]): Promise<void> {
  if (candidates.length === 0) {
    return;
  }

  console.log(candidates.map((candidate) => candidate.path).join("\n"));
}

async function cat(
  candidates: readonly PathCandidate[],
  options: ParsedArgs,
  passwords: PasswordResolver,
): Promise<void> {
  const plan = planCopyOrder(candidates);

  for (const candidate of plan) {
    if (candidate.kind === "directory") {
      fail(`${candidate.path}: cannot cat a directory`);
    }

    if (candidate.specialFileType !== "none") {
      fail(`${candidate.path}: cannot cat a special file entry`);
    }

    const data = await candidate.readData({
      checkCrc: shouldCheckChecksum(candidate.path, options.ignoreChecksum),
      password: await passwords.resolve(candidate.path),
    });
    await writeStdout(data);
  }
}

async function copy(
  candidates: readonly PathCandidate[],
  options: ParsedArgs,
  passwords: PasswordResolver,
): Promise<void> {
  const files: PathCandidate[] = [];
  const directories: PathCandidate[] = [];
  const output = await DirectoryEnsurer.create(options.lockdown);
  const fallbackDirectoryMode = fallbackDirectoryModeFor(options);
  let bytesTotal = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;

    if (candidate.kind === "file") {
      files.push(candidate);
      bytesTotal += candidate.uncompressedSize;
    } else {
      directories.push(candidate);
    }
  }

  const progress = new CopyProgress({
    mode: options.progress,
  });

  progress.start({
    filesTotal: files.length,
    bytesTotal,
  });
  progress.startPlanning({
    label: "resolving zip ranges",
    filesTotal: files.length,
  });
  const groups = await buildCopyGroups(files, {
    onFile: (file, index, total) => {
      progress.advancePlanning({
        path: file.path,
        filesDone: Math.min(index + 1, total),
      });
    },
  });
  progress.finishPlanning();

  for (let index = 0; index < directories.length; index += 1) {
    const candidate = directories[index]!;
    const result = await output.ensureFinalDirectory(candidate.path);

    if (result.created) {
      output.noteExplicitDirectoryMode(
        result.target,
        modeForCandidate(candidate, options),
        fallbackDirectoryMode,
      );
    }
  }

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]!;

    if (group.range !== undefined) {
      await group.files[0]!.primeRange(group.range.offset, group.range.length);
    }

    await runLimited(group.files, options.jobs, async (candidate) => {
      await copyEntry(candidate, options, passwords, progress, output);
    });
  }

  await output.applyCreatedDirectoryModes(fallbackDirectoryMode);
  progress.finish();
}

export function planCopyOrder(candidates: readonly PathCandidate[]): PathCandidate[] {
  const directories: PathCandidate[] = [];
  const files: PathCandidate[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;

    if (candidate.kind === "directory") {
      directories.push(candidate);
    } else {
      files.push(candidate);
    }
  }

  files.sort((left, right) => {
    const byArchive = left.archiveLabel.localeCompare(right.archiveLabel);

    if (byArchive !== 0) {
      return byArchive;
    }

    const leftOffset = left.physicalOffset ?? Number.MAX_SAFE_INTEGER;
    const rightOffset = right.physicalOffset ?? Number.MAX_SAFE_INTEGER;

    if (leftOffset !== rightOffset) {
      return leftOffset - rightOffset;
    }

    return left.path.localeCompare(right.path);
  });

  const planned: PathCandidate[] = new Array(directories.length + files.length);
  let outputIndex = 0;

  for (let index = 0; index < directories.length; index += 1) {
    planned[outputIndex] = directories[index]!;
    outputIndex += 1;
  }

  for (let index = 0; index < files.length; index += 1) {
    planned[outputIndex] = files[index]!;
    outputIndex += 1;
  }

  return planned;
}

export interface CopyGroup {
  files: PathCandidate[];
  range: { offset: number; length: number } | undefined;
}

export interface BuildCopyGroupsOptions {
  onFile?: (file: PathCandidate, index: number, total: number) => void;
}

const maxPrimeGap = 64 * 1024;
const maxPrimeRange = 32 * 1024 * 1024;
const bufferedCopyThreshold = 0;

async function copyEntry(
  candidate: PathCandidate,
  options: ParsedArgs,
  passwords: PasswordResolver,
  progress: CopyProgress,
  output: DirectoryEnsurer,
): Promise<void> {
  if (candidate.specialFileType === "none") {
    return copyFile(candidate, options, passwords, progress, output);
  }

  return copySpecialFile(candidate, options, passwords, progress, output);
}

async function copySpecialFile(
  candidate: PathCandidate,
  options: ParsedArgs,
  passwords: PasswordResolver,
  progress: CopyProgress,
  output: DirectoryEnsurer,
): Promise<void> {
  if (!isSpecialFileTypeAllowed(candidate.specialFileType, options.specialFileTypes)) {
    if (candidate.specialFileType === "symlink") {
      fail(`${candidate.path}: refusing to extract ZIP symlink entry`);
    }

    fail(`${candidate.path}: refusing to extract ZIP special file entry`);
  }

  const mode = modeForCandidate(candidate, options);

  switch (candidate.specialFileType) {
    case "symlink": {
      progress.startFile({
        path: candidate.path,
        bytesTotal: candidate.uncompressedSize,
      });
      const data = await candidate.readData({
        checkCrc: shouldCheckChecksum(candidate.path, options.ignoreChecksum),
        password: await passwords.resolve(candidate.path),
      });
      await createSymlinkExclusive(candidate.path, data, output);
      progress.advanceFile(data.byteLength);
      progress.finishFile();
      return;
    }

    case "fifo":
      return copyEmptySpecialFile(candidate, progress, () =>
        createFifoExclusive(candidate.path, output, mode),
      );

    case "socket":
      return copyEmptySpecialFile(candidate, progress, () =>
        createSocketExclusive(candidate.path, output, mode),
      );

    case "char-device":
    case "block-device": {
      if (candidate.deviceNumbers === undefined) {
        fail(`${candidate.path}: ${candidate.specialFileType} entry is missing device numbers`);
      }

      const deviceType = candidate.specialFileType;
      const deviceNumbers = candidate.deviceNumbers;
      return copyEmptySpecialFile(candidate, progress, () =>
        createDeviceExclusive(
          candidate.path,
          output,
          mode,
          deviceType,
          deviceNumbers,
        ),
      );
    }

    case "unknown":
      fail(`${candidate.path}: unsupported ZIP special file entry type`);

    case "none":
      return copyFile(candidate, options, passwords, progress, output);
  }
}

async function copyEmptySpecialFile(
  candidate: PathCandidate,
  progress: CopyProgress,
  create: () => Promise<void>,
): Promise<void> {
  progress.startFile({
    path: candidate.path,
    bytesTotal: candidate.uncompressedSize,
  });
  await create();
  progress.finishFile();
}

async function copyFile(
  candidate: PathCandidate,
  options: ParsedArgs,
  passwords: PasswordResolver,
  progress: CopyProgress,
  output: DirectoryEnsurer,
): Promise<void> {
  progress.startFile({
    path: candidate.path,
    bytesTotal: candidate.uncompressedSize,
  });
  const mode = modeForCandidate(candidate, options);

  if (candidate.compressedSize <= bufferedCopyThreshold) {
    const data = await candidate.readData({
      checkCrc: shouldCheckChecksum(candidate.path, options.ignoreChecksum),
      password: await passwords.resolve(candidate.path),
    });
    await writeFileExclusive(candidate.path, data, output, mode);
    progress.advanceFile(data.byteLength);
    progress.finishFile();
    return;
  }

  await writeFileExclusiveStream(
    candidate.path,
    candidate.streamData({
      checkCrc: shouldCheckChecksum(candidate.path, options.ignoreChecksum),
      password: await passwords.resolve(candidate.path),
    }),
    output,
    mode,
    (bytes) => {
      progress.advanceFile(bytes);
    },
  );

  progress.finishFile();
}

function fallbackDirectoryModeFor(options: ParsedArgs): number {
  return modeForCandidate(
    {
      kind: "directory",
      unixMode: undefined,
    },
    options,
  );
}

async function runLimited<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let firstError: unknown;
  const workerCount = Math.min(limit, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (firstError === undefined) {
        const index = next;
        next += 1;

        if (index >= items.length) {
          return;
        }

        try {
          await worker(items[index]!);
        } catch (error) {
          firstError = error;
        }
      }
    }),
  );

  if (firstError !== undefined) {
    throw firstError;
  }
}

export async function buildCopyGroups(
  files: readonly PathCandidate[],
  options: BuildCopyGroupsOptions = {},
): Promise<CopyGroup[]> {
  const planned = planCopyOrder(files);
  const groups: CopyGroup[] = [];
  let current:
    | {
        archiveLabel: string;
        files: PathCandidate[];
        start: number;
        end: number;
      }
    | undefined;

  for (let index = 0; index < planned.length; index += 1) {
    const file = planned[index]!;

    if (file.kind !== "file") {
      continue;
    }

    options.onFile?.(file, index, planned.length);
    const range = file.planRange();

    if (range === undefined || range.length === 0 || range.length > maxPrimeRange) {
      flush();
      groups.push({
        files: [file],
        range: undefined,
      });
      continue;
    }

    const start = range.offset;
    const end = range.offset + range.length;

    if (
      current !== undefined &&
      current.archiveLabel === file.archiveLabel &&
      start >= current.end &&
      start - current.end <= maxPrimeGap &&
      end - current.start <= maxPrimeRange
    ) {
      current.files.push(file);
      current.end = end;
      continue;
    }

    flush();
    current = {
      archiveLabel: file.archiveLabel,
      files: [file],
      start,
      end,
    };
  }

  flush();
  return groups;

  function flush(): void {
    if (current === undefined) {
      return;
    }

    groups.push({
      files: current.files,
      range: {
        offset: current.start,
        length: current.end - current.start,
      },
    });
    current = undefined;
  }
}

function shouldCheckChecksum(path: string, ignoreChecksum: readonly RegExp[]): boolean {
  for (let index = 0; index < ignoreChecksum.length; index += 1) {
    const regex = ignoreChecksum[index]!;
    regex.lastIndex = 0;
    if (regex.test(path)) {
      return false;
    }
  }

  return true;
}

async function writeStdout(data: Uint8Array): Promise<void> {
  if (process.stdout.write(data)) {
    return;
  }

  await new Promise<void>((resolve) => {
    process.stdout.once("drain", resolve);
  });
}
