import { collectArchiveCandidates, expandStoredZipAsDirectory } from "./archive.ts";
import { fail } from "./errors.ts";
import type { ParsedArgs } from "./options.ts";
import { prepareFinalCandidates, type PathCandidate } from "./path-pipeline.ts";
import { createDirectory, writeFileExclusive } from "./safe-write.ts";

export async function runCommand(options: ParsedArgs): Promise<void> {
  const archiveSet = await collectArchiveCandidates(options.archives, {
    proxy: options.proxy,
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
        await copy(candidates, options.ignoreChecksum, options.lockdown);
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
  for (const candidate of candidates) {
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
): Promise<void> {
  for (const candidate of candidates) {
    if (candidate.kind === "directory") {
      await createDirectory(candidate.path, lockdown);
      continue;
    }

    if (candidate.isSymlink) {
      fail(`${candidate.path}: refusing to extract ZIP symlink entry`);
    }

    const data = await candidate.readData({
      checkCrc: shouldCheckChecksum(candidate.path, ignoreChecksum),
    });
    await writeFileExclusive(candidate.path, data, lockdown);
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
