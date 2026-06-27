import { fail } from "./errors.ts";
import { openRangeSource, type RangeSource } from "./range-source.ts";
import type { HttpTransport } from "./range-source.ts";
import type { PathCandidate } from "./path-pipeline.ts";
import { joinVirtualPath, stripLastExtension } from "./path-utils.ts";
import { ZipArchive, type ZipEntry } from "./zip.ts";

export interface ArchiveOpenOptions {
  proxy: string | undefined;
  httpTransport: HttpTransport;
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
  if (candidate.kind !== "file") {
    fail(`${candidate.path}: --as-dir matched a directory`);
  }

  if (candidate.compressionMethod !== 0) {
    fail(`${candidate.path}: --as-dir requires ZIP compression method 0 (stored)`);
  }

  const bytes = await candidate.readData({ checkCrc: true });
  const archive = ZipArchive.fromBuffer(bytes, `${candidate.archiveLabel}!${candidate.path}`);
  const entries = await archive.entries();
  const prefix = keepExtension ? candidate.path : stripLastExtension(candidate.path);

  return entries.map((entry) =>
    candidateFromZipEntry(
      archive,
      entry,
      joinVirtualPath(prefix, entry.path),
      `${candidate.sourcePath}!${entry.path}`,
      candidate.absoluteFromReplace,
    ),
  );
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
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    physicalOffset: entry.localHeaderOffset,
    absoluteFromReplace,
    isSymlink: entry.isSymlink,
    readData: (options) => archive.readEntry(entry, options),
    streamData: (options) => archive.streamEntry(entry, options),
    planRange: () => archive.entryPlannedRange(entry),
    dataRange: () => archive.entryDataRange(entry),
    primeRange: (offset, length) => archive.primeRange(offset, length),
  };
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
