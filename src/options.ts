import { fail } from "./errors.ts";
import { globMatcher, regexMatcher, type PathMatcher } from "./matcher.ts";
import type { PathOperation } from "./path-pipeline.ts";
import type { HttpTransport } from "./range-source.ts";

export type Command = "ls" | "cat" | "cp" | "du" | "stat";
export type ProgressMode = "auto" | "always" | "never";
export type DuGroupBy = "none" | "archive" | "dir";

export interface ParsedArgs {
  command: Command;
  archives: string[];
  operations: PathOperation[];
  ignoreChecksum: RegExp[];
  proxy: string | undefined;
  httpTransport: HttpTransport;
  lockdown: string | undefined;
  progress: ProgressMode;
  jobs: number;
  json: boolean;
  jsonl: boolean;
  bytes: boolean;
  groupBy: DuGroupBy;
  depth: number | undefined;
  all: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0];

  if (
    command !== "ls" &&
    command !== "cat" &&
    command !== "cp" &&
    command !== "du" &&
    command !== "stat"
  ) {
    fail(command === undefined ? "missing command" : `unknown command: ${command}`);
  }

  const archives: string[] = [];
  const operations: PathOperation[] = [];
  const ignoreChecksum: RegExp[] = [];
  let proxy: string | undefined;
  let httpTransport: HttpTransport = "fetch";
  let lockdown: string | undefined;
  let progress: ProgressMode = "auto";
  let jobs = 1;
  let json = false;
  let jsonl = false;
  let bytes = false;
  let groupBy: DuGroupBy = "none";
  let depth: number | undefined;
  let all = false;
  let optionsEnded = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (optionsEnded) {
      archives.push(arg);
      continue;
    }

    if (arg === "--") {
      optionsEnded = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      archives.push(arg);
      continue;
    }

    switch (arg) {
      case "--proxy":
        proxy = requireValue(argv, ++index, arg);
        break;

      case "--http":
        httpTransport = parseHttpTransport(requireValue(argv, ++index, arg));
        break;

      case "--lockdown":
        lockdown = requireValue(argv, ++index, arg);
        break;

      case "--progress":
        progress = parseProgressMode(requireValue(argv, ++index, arg));
        break;

      case "--jobs":
        jobs = parsePositiveInteger(requireValue(argv, ++index, arg), arg);
        break;

      case "--no-progress":
        progress = "never";
        break;

      case "--json":
        json = true;
        break;

      case "--jsonl":
        jsonl = true;
        break;

      case "--bytes":
        bytes = true;
        break;

      case "--by":
        groupBy = parseDuGroupBy(requireValue(argv, ++index, arg));
        break;

      case "--depth":
        depth = parseNonNegativeInteger(requireValue(argv, ++index, arg), arg);
        break;

      case "--all":
        all = true;
        break;

      case "--ignore-checksum":
        ignoreChecksum.push(compileRegex(requireValue(argv, ++index, arg), arg));
        break;

      case "--match":
      case "--matches":
      case "--include": {
        const pattern = requireValue(argv, ++index, arg);
        operations.push(includeOperation(regexMatcher(pattern, arg)));
        break;
      }

      case "--include-glob":
      case "--match-glob":
      case "--matches-glob": {
        const pattern = requireValue(argv, ++index, arg);
        operations.push(includeOperation(globMatcher(pattern, arg)));
        break;
      }

      case "--or": {
        const pattern = requireValue(argv, ++index, arg);
        appendOrMatcher(operations, regexMatcher(pattern, arg), arg);
        break;
      }

      case "--or-glob": {
        const pattern = requireValue(argv, ++index, arg);
        appendOrMatcher(operations, globMatcher(pattern, arg), arg);
        break;
      }

      case "--exclude": {
        const pattern = requireValue(argv, ++index, arg);
        operations.push({
          kind: "exclude",
          matcher: regexMatcher(pattern, arg),
        });
        break;
      }

      case "--exclude-glob": {
        const pattern = requireValue(argv, ++index, arg);
        operations.push({
          kind: "exclude",
          matcher: globMatcher(pattern, arg),
        });
        break;
      }

      case "--replace": {
        const pattern = requireValue(argv, ++index, arg);
        const replacement = requireValue(argv, ++index, arg);
        operations.push({
          kind: "replace",
          pattern,
          regex: compileRegex(pattern, arg),
          replacement,
        });
        break;
      }

      case "--cut-prefix":
      case "--strip-components": {
        const value = requireValue(argv, ++index, arg);
        operations.push({
          kind: "strip-components",
          count: parseNonNegativeInteger(value, arg),
        });
        break;
      }

      case "--flatten":
        operations.push({ kind: "flatten" });
        break;

      case "--as-dir":
      case "--archive-is-dir": {
        const pattern = requireValue(argv, ++index, arg);
        operations.push({
          kind: "as-dir",
          matcher: regexMatcher(pattern, arg),
          keepExtension: false,
        });
        break;
      }

      case "--as-dir-glob":
      case "--archive-is-dir-glob": {
        const pattern = requireValue(argv, ++index, arg);
        operations.push({
          kind: "as-dir",
          matcher: globMatcher(pattern, arg),
          keepExtension: false,
        });
        break;
      }

      case "--as-dir-keep-ext":
      case "--archive-is-dir-keep-ext": {
        const pattern = requireValue(argv, ++index, arg);
        operations.push({
          kind: "as-dir",
          matcher: regexMatcher(pattern, arg),
          keepExtension: true,
        });
        break;
      }

      case "--as-dir-keep-ext-glob":
      case "--archive-is-dir-keep-ext-glob": {
        const pattern = requireValue(argv, ++index, arg);
        operations.push({
          kind: "as-dir",
          matcher: globMatcher(pattern, arg),
          keepExtension: true,
        });
        break;
      }

      default:
        fail(`unknown option: ${arg}`);
    }
  }

  if (archives.length === 0) {
    fail(`${command}: expected at least one archive path or URL`);
  }

  return {
    command,
    archives,
    operations,
    ignoreChecksum,
    proxy,
    httpTransport,
    lockdown,
    progress,
    jobs,
    json,
    jsonl,
    bytes,
    groupBy,
    depth,
    all,
  };
}

function requireValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];

  if (value === undefined) {
    fail(`${option}: expected a value`);
  }

  return value;
}

function compileRegex(pattern: string, option: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    fail(`${option}: invalid regex ${JSON.stringify(pattern)}: ${String(error)}`);
  }
}

function includeOperation(matcher: PathMatcher): PathOperation {
  return {
    kind: "include",
    matchers: [matcher],
  };
}

function appendOrMatcher(
  operations: PathOperation[],
  matcher: PathMatcher,
  option: string,
): void {
  const previous = operations[operations.length - 1];

  if (previous?.kind !== "include") {
    fail(`${option}: expected a preceding --include, --match, or --include-glob`);
  }

  previous.matchers.push(matcher);
}

function parseNonNegativeInteger(value: string, option: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    fail(`${option}: expected a non-negative integer`);
  }

  return Number(value);
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    fail(`${option}: expected a positive integer`);
  }

  return Number(value);
}

function parseProgressMode(value: string): ProgressMode {
  if (value === "auto" || value === "always" || value === "never") {
    return value;
  }

  fail(`--progress: expected auto, always, or never`);
}

function parseHttpTransport(value: string): HttpTransport {
  if (value === "fetch" || value === "http1" || value === "http2") {
    return value;
  }

  fail(`--http: expected fetch, http1, or http2`);
}

function parseDuGroupBy(value: string): DuGroupBy {
  if (value === "none" || value === "archive" || value === "dir") {
    return value;
  }

  fail(`--by: expected none, archive, or dir`);
}
