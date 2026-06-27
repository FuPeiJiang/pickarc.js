import { fail } from "./errors.ts";
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
      pattern: string;
      regex: RegExp;
    }
  | {
      kind: "exclude";
      pattern: string;
      regex: RegExp;
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
      pattern: string;
      regex: RegExp;
      keepExtension: boolean;
    };

export interface PathCandidate {
  id: string;
  archiveLabel: string;
  sourcePath: string;
  path: string;
  kind: "file" | "directory";
  compressionMethod: number | undefined;
  absoluteFromReplace: boolean;
  isSymlink: boolean;
  readData: (options: { checkCrc: boolean }) => Promise<Uint8Array>;
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
  let candidates = input.map((candidate) => ({ ...candidate }));

  for (const operation of operations) {
    switch (operation.kind) {
      case "include":
        candidates = candidates.filter((candidate) => testRegex(operation.regex, candidate.path));
        break;

      case "exclude":
        candidates = candidates.filter((candidate) => !testRegex(operation.regex, candidate.path));
        break;

      case "replace":
        candidates = candidates.map((candidate) => {
          operation.regex.lastIndex = 0;
          const replaced = candidate.path.replace(operation.regex, operation.replacement);
          const normalized = normalizeVirtualPath(replaced, "--replace");

          return {
            ...candidate,
            path: normalized,
            absoluteFromReplace:
              candidate.absoluteFromReplace ||
              (normalized !== candidate.path && isAbsoluteLikePath(normalized)),
          };
        });
        break;

      case "strip-components":
        candidates = candidates.flatMap((candidate) => {
          const stripped = stripLeadingComponents(candidate.path, operation.count);
          return stripped === undefined
            ? []
            : [
                {
                  ...candidate,
                  path: stripped,
                },
              ];
        });
        break;

      case "flatten":
        candidates = candidates.map((candidate) => ({
          ...candidate,
          path: basenameOfVirtualPath(candidate.path),
        }));
        break;

      case "as-dir": {
        if (expandAsDir === undefined) {
          fail("--as-dir is unavailable without an archive expander");
        }

        const next: PathCandidate[] = [];

        for (const candidate of candidates) {
          if (testRegex(operation.regex, candidate.path)) {
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
  const candidates = input.map((candidate) => {
    const normalized = normalizeVirtualPath(candidate.path, "final path");
    assertUsableFinalPath(normalized, candidate.absoluteFromReplace);

    return {
      ...candidate,
      path: normalized,
    };
  });

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

export async function prepareFinalCandidates(
  input: readonly PathCandidate[],
  operations: readonly PathOperation[],
  expandAsDir?: ExpandAsDir,
): Promise<PathCandidate[]> {
  return sortAndValidateFinalPaths(await applyPathOperations(input, operations, expandAsDir));
}

function testRegex(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0;
  return regex.test(value);
}
