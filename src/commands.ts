import { collectArchiveCandidates, expandStoredZipAsDirectory } from "./archive.ts";
import { fail } from "./errors.ts";
import type { ParsedArgs } from "./options.ts";
import { prepareFinalCandidates, type PathCandidate } from "./path-pipeline.ts";
import { CopyProgress } from "./progress.ts";
import { createDirectory, writeFileExclusiveStream } from "./safe-write.ts";

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
        await copy(candidates, options.ignoreChecksum, options.lockdown, options.progress);
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
): Promise<void> {
  const files = candidates.filter((candidate) => candidate.kind === "file");
  const progress = new CopyProgress({
    mode: progressMode,
  });

  progress.start({
    filesTotal: files.length,
    bytesTotal: files.reduce((total, candidate) => total + candidate.uncompressedSize, 0),
  });

  for (const candidate of candidates) {
    if (candidate.kind === "directory") {
      await createDirectory(candidate.path, lockdown);
      continue;
    }

    if (candidate.isSymlink) {
      fail(`${candidate.path}: refusing to extract ZIP symlink entry`);
    }

    progress.startFile({
      path: candidate.path,
      bytesTotal: candidate.uncompressedSize,
    });

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
