import { fail } from "./errors.ts";
import type { PathMatcher } from "./matcher.ts";
import { matchesAny } from "./matcher.ts";
import type { ArchiveFileType } from "./permissions.ts";
import type { DeviceNumbers } from "./zip.ts";
import {
  assertUsableFinalPath,
  basenameOfVirtualPath,
  isAbsoluteLikePath,
  normalizeVirtualPath,
  stripLeadingComponents,
} from "./path-utils.ts";

export type PathOperation =
  | {
      kind: "include";
      matchers: PathMatcher[];
    }
  | {
      kind: "exclude";
      matcher: PathMatcher;
    }
  | {
      kind: "replace";
      pattern: string;
      regex: RegExp;
      replacement: string;
    }
  | {
      kind: "strip-components";
      count: number;
    }
  | {
      kind: "flatten";
    }
  | {
      kind: "as-dir";
      matcher: PathMatcher;
      keepExtension: boolean;
    };

export interface PathCandidate {
  id: string;
  archiveLabel: string;
  sourcePath: string;
  path: string;
  kind: "file" | "directory";
  compressionMethod: number | undefined;
  rawCompressionMethod: number | undefined;
  crc32: number | undefined;
  compressedSize: number;
  uncompressedSize: number;
  physicalOffset: number | undefined;
  absoluteFromReplace: boolean;
  unixMode: number | undefined;
  specialFileType: ArchiveFileType;
  deviceNumbers: DeviceNumbers | undefined;
  isSymlink: boolean;
  isSpecialFile: boolean;
  encrypted: boolean;
  encryptionMethod: "none" | "zipcrypto" | "aes";
  readData: (options: { checkCrc: boolean; password?: string | undefined }) => Promise<Uint8Array>;
  streamData: (options: { checkCrc: boolean; password?: string | undefined }) => AsyncIterable<Uint8Array>;
  planRange: () => { offset: number; length: number } | undefined;
  dataRange: () => Promise<{ offset: number; length: number } | undefined>;
  primeRange: (offset: number, length: number) => Promise<void>;
  expandAsDirectory:
    | ((candidate: PathCandidate, keepExtension: boolean) => Promise<PathCandidate[]>)
    | undefined;
}

export type ExpandAsDir = (
  candidate: PathCandidate,
  keepExtension: boolean,
) => Promise<PathCandidate[]>;

export async function applyPathOperations(
  input: readonly PathCandidate[],
  operations: readonly PathOperation[],
  expandAsDir?: ExpandAsDir,
): Promise<PathCandidate[]> {
  let candidates: PathCandidate[] = new Array(input.length);

  for (let index = 0; index < input.length; index += 1) {
    candidates[index] = cloneCandidate(input[index]!);
  }

  for (const operation of operations) {
    switch (operation.kind) {
      case "include": {
        const next: PathCandidate[] = [];

        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;

          if (matchesAny(operation.matchers, candidate.path)) {
            next.push(candidate);
          }
        }

        candidates = next;
        break;
      }

      case "exclude": {
        const next: PathCandidate[] = [];

        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;

          if (!operation.matcher.matches(candidate.path)) {
            next.push(candidate);
          }
        }

        candidates = next;
        break;
      }

      case "replace": {
        const next: PathCandidate[] = new Array(candidates.length);

        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;
          operation.regex.lastIndex = 0;
          const replaced = candidate.path.replace(operation.regex, operation.replacement);
          const normalized = normalizeVirtualPath(replaced, "--replace");

          next[index] = cloneCandidate(
            candidate,
            normalized,
            candidate.absoluteFromReplace ||
              (normalized !== candidate.path && isAbsoluteLikePath(normalized)),
          );
        }

        candidates = next;
        break;
      }

      case "strip-components": {
        const next: PathCandidate[] = [];

        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;
          const stripped = stripLeadingComponents(candidate.path, operation.count);

          if (stripped !== undefined) {
            next.push(cloneCandidate(candidate, stripped));
          }
        }

        candidates = next;
        break;
      }

      case "flatten": {
        const next: PathCandidate[] = new Array(candidates.length);

        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;
          next[index] = cloneCandidate(candidate, basenameOfVirtualPath(candidate.path));
        }

        candidates = next;
        break;
      }

      case "as-dir": {
        if (expandAsDir === undefined) {
          fail("--as-dir is unavailable without an archive expander");
        }

        const next: PathCandidate[] = [];

        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;

          if (operation.matcher.matches(candidate.path)) {
            next.push(...(await expandAsDir(candidate, operation.keepExtension)));
          } else {
            next.push(candidate);
          }
        }

        candidates = next;
        break;
      }
    }
  }

  return candidates;
}

export function sortAndValidateFinalPaths(input: readonly PathCandidate[]): PathCandidate[] {
  const candidates: PathCandidate[] = new Array(input.length);

  for (let index = 0; index < input.length; index += 1) {
    const candidate = input[index]!;
    const normalized = normalizeVirtualPath(candidate.path, "final path");
    assertUsableFinalPath(normalized, candidate.absoluteFromReplace);

    candidates[index] = cloneCandidate(candidate, normalized);
  }

  candidates.sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    return byPath === 0 ? left.id.localeCompare(right.id) : byPath;
  });

  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1]!;
    const current = candidates[index]!;

    if (previous.path === current.path) {
      fail(`duplicate final path after rewrite rules: ${current.path}`);
    }
  }

  return candidates;
}

function cloneCandidate(
  candidate: PathCandidate,
  path = candidate.path,
  absoluteFromReplace = candidate.absoluteFromReplace,
): PathCandidate {
  return {
    id: candidate.id,
    archiveLabel: candidate.archiveLabel,
    sourcePath: candidate.sourcePath,
    path,
    kind: candidate.kind,
    compressionMethod: candidate.compressionMethod,
    rawCompressionMethod: candidate.rawCompressionMethod,
    crc32: candidate.crc32,
    compressedSize: candidate.compressedSize,
    uncompressedSize: candidate.uncompressedSize,
    physicalOffset: candidate.physicalOffset,
    absoluteFromReplace,
    unixMode: candidate.unixMode,
    specialFileType: candidate.specialFileType,
    deviceNumbers: candidate.deviceNumbers,
    isSymlink: candidate.isSymlink,
    isSpecialFile: candidate.isSpecialFile,
    encrypted: candidate.encrypted,
    encryptionMethod: candidate.encryptionMethod,
    readData: candidate.readData,
    streamData: candidate.streamData,
    planRange: candidate.planRange,
    dataRange: candidate.dataRange,
    primeRange: candidate.primeRange,
    expandAsDirectory: candidate.expandAsDirectory,
  };
}

export async function prepareFinalCandidates(
  input: readonly PathCandidate[],
  operations: readonly PathOperation[],
  expandAsDir?: ExpandAsDir,
): Promise<PathCandidate[]> {
  return sortAndValidateFinalPaths(await applyPathOperations(input, operations, expandAsDir));
}
