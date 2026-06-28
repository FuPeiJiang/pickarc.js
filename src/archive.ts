import { fail } from "./errors.ts";
import { openRangeSource, type RangeSource } from "./range-source.ts";
import type { PathCandidate } from "./path-pipeline.ts";
import { joinVirtualPath, stripLastExtension } from "./path-utils.ts";
import { ZipArchive, type ZipEntry } from "./zip.ts";

export interface ArchiveOpenOptions {
  proxy: string | undefined;
  insecure: boolean;
}

export interface ArchiveSet {
  candidates: PathCandidate[];
  close(): Promise<void>;
}

export async function collectArchiveCandidates(
  inputs: readonly string[],
  options: ArchiveOpenOptions,
): Promise<ArchiveSet> {
  const sources: RangeSource[] = [];
  const candidates: PathCandidate[] = [];

  try {
    for (const input of inputs) {
      const source = await openRangeSource(input, options);
      sources.push(source);
      const archive = new ZipArchive(source, input);
      const entries = await archive.entries();
      candidates.push(...entries.map((entry) => candidateFromZipEntry(archive, entry, entry.path)));
    }
  } catch (error) {
    await closeAll(sources);
    throw error;
  }

  return {
    candidates,
    close: async () => {
      await closeAll(sources);
    },
  };
}

export async function expandStoredZipAsDirectory(
  candidate: PathCandidate,
  keepExtension: boolean,
): Promise<PathCandidate[]> {
  if (candidate.expandAsDirectory === undefined) {
    fail(`${candidate.path}: --as-dir is unavailable for this entry`);
  }

  return candidate.expandAsDirectory(candidate, keepExtension);
}

function candidateFromZipEntry(
  archive: ZipArchive,
  entry: ZipEntry,
  path: string,
  sourcePath = entry.path,
  absoluteFromReplace = false,
): PathCandidate {
  return {
    id: entry.id,
    archiveLabel: archive.label,
    sourcePath,
    path,
    kind: entry.kind,
    compressionMethod: entry.compressionMethod,
    rawCompressionMethod: entry.rawCompressionMethod,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    physicalOffset: entry.localHeaderOffset,
    absoluteFromReplace,
    isSymlink: entry.isSymlink,
    encrypted: entry.encrypted,
    encryptionMethod: entry.encryptionMethod,
    readData: (options) => archive.readEntry(entry, options),
    streamData: (options) => archive.streamEntry(entry, options),
    planRange: () => archive.entryPlannedRange(entry),
    dataRange: () => archive.entryDataRange(entry),
    primeRange: (offset, length) => archive.primeRange(offset, length),
    expandAsDirectory: (candidate, keepExtension) =>
      expandZipEntryAsDirectory(archive, entry, candidate, keepExtension),
  };
}

async function expandZipEntryAsDirectory(
  archive: ZipArchive,
  entry: ZipEntry,
  candidate: PathCandidate,
  keepExtension: boolean,
): Promise<PathCandidate[]> {
  if (candidate.kind !== "file") {
    fail(`${candidate.path}: --as-dir matched a directory`);
  }

  if (candidate.compressionMethod !== 0) {
    fail(`${candidate.path}: --as-dir requires ZIP compression method 0 (stored)`);
  }

  const nestedArchive = await archive.openStoredEntryAsArchive(
    entry,
    `${candidate.archiveLabel}!${candidate.path}`,
  );
  const entries = await nestedArchive.entries();
  const prefix = keepExtension ? candidate.path : stripLastExtension(candidate.path);

  return entries.map((nestedEntry) =>
    candidateFromZipEntry(
      nestedArchive,
      nestedEntry,
      joinVirtualPath(prefix, nestedEntry.path),
      `${candidate.sourcePath}!${nestedEntry.path}`,
      candidate.absoluteFromReplace,
    ),
  );
}

async function closeAll(sources: readonly RangeSource[]): Promise<void> {
  const errors: unknown[] = [];

  for (const source of sources) {
    try {
      await source.close?.();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw errors[0];
  }
}
