import { collectArchiveCandidates, expandStoredZipAsDirectory } from "./archive.ts";
import { fail } from "./errors.ts";
import type { ParsedArgs } from "./options.ts";
import { prepareFinalCandidates, type PathCandidate } from "./path-pipeline.ts";
import { CopyProgress } from "./progress.ts";
import { createDirectory, writeFileExclusive, writeFileExclusiveStream } from "./safe-write.ts";

export async function runCommand(options: ParsedArgs): Promise<void> {
  const archiveSet = await collectArchiveCandidates(options.archives, {
    proxy: options.proxy,
    httpTransport: options.httpTransport,
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
        await cat(candidates, options.ignoreChecksum);
        break;

      case "cp":
        await copy(candidates, options.ignoreChecksum, options.lockdown, options.progress, options.jobs);
        break;
    }
  } finally {
    await archiveSet.close();
  }
}

async function list(candidates: readonly PathCandidate[]): Promise<void> {
  if (candidates.length === 0) {
    return;
  }

  console.log(candidates.map((candidate) => candidate.path).join("\n"));
}

async function cat(candidates: readonly PathCandidate[], ignoreChecksum: readonly RegExp[]): Promise<void> {
  const plan = planCopyOrder(candidates);

  for (const candidate of plan) {
    if (candidate.kind === "directory") {
      fail(`${candidate.path}: cannot cat a directory`);
    }

    const data = await candidate.readData({
      checkCrc: shouldCheckChecksum(candidate.path, ignoreChecksum),
    });
    await writeStdout(data);
  }
}

async function copy(
  candidates: readonly PathCandidate[],
  ignoreChecksum: readonly RegExp[],
  lockdown: string | undefined,
  progressMode: ParsedArgs["progress"],
  jobs: number,
): Promise<void> {
  const files = candidates.filter((candidate) => candidate.kind === "file");
  const progress = new CopyProgress({
    mode: progressMode,
  });

  progress.start({
    filesTotal: files.length,
    bytesTotal: files.reduce((total, candidate) => total + candidate.uncompressedSize, 0),
  });

  for (const candidate of candidates.filter((candidate) => candidate.kind === "directory")) {
    await createDirectory(candidate.path, lockdown);
  }

  for (const group of await buildCopyGroups(files)) {
    if (group.range !== undefined) {
      await group.files[0]!.primeRange(group.range.offset, group.range.length);
    }

    await runLimited(group.files, jobs, async (candidate) => {
      if (candidate.isSymlink) {
        fail(`${candidate.path}: refusing to extract ZIP symlink entry`);
      }

      await copyFile(candidate, ignoreChecksum, lockdown, progress);
    });
  }

  progress.finish();
}

export function planCopyOrder(candidates: readonly PathCandidate[]): PathCandidate[] {
  const directories = candidates.filter((candidate) => candidate.kind === "directory");
  const files = candidates
    .filter((candidate) => candidate.kind === "file")
    .toSorted((left, right) => {
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

  return [...directories, ...files];
}

export interface CopyGroup {
  files: PathCandidate[];
  range: { offset: number; length: number } | undefined;
}

const maxPrimeGap = 64 * 1024;
const maxPrimeRange = 32 * 1024 * 1024;
const bufferedCopyThreshold = 0;

async function copyFile(
  candidate: PathCandidate,
  ignoreChecksum: readonly RegExp[],
  lockdown: string | undefined,
  progress: CopyProgress,
): Promise<void> {
  progress.startFile({
    path: candidate.path,
    bytesTotal: candidate.uncompressedSize,
  });

  if (candidate.compressedSize <= bufferedCopyThreshold) {
    const data = await candidate.readData({
      checkCrc: shouldCheckChecksum(candidate.path, ignoreChecksum),
    });
    await writeFileExclusive(candidate.path, data, lockdown);
    progress.advanceFile(data.byteLength);
    progress.finishFile();
    return;
  }

  await writeFileExclusiveStream(
    candidate.path,
    candidate.streamData({
      checkCrc: shouldCheckChecksum(candidate.path, ignoreChecksum),
    }),
    lockdown,
    (bytes) => {
      progress.advanceFile(bytes);
    },
  );

  progress.finishFile();
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

export async function buildCopyGroups(files: readonly PathCandidate[]): Promise<CopyGroup[]> {
  const planned = planCopyOrder(files).filter((candidate) => candidate.kind === "file");
  const groups: CopyGroup[] = [];
  let current:
    | {
        archiveLabel: string;
        files: PathCandidate[];
        start: number;
        end: number;
      }
    | undefined;

  for (const file of planned) {
    const range = await file.dataRange();

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
  return !ignoreChecksum.some((regex) => {
    regex.lastIndex = 0;
    return regex.test(path);
  });
}

async function writeStdout(data: Uint8Array): Promise<void> {
  if (process.stdout.write(data)) {
    return;
  }

  await new Promise<void>((resolve) => {
    process.stdout.once("drain", resolve);
  });
}
