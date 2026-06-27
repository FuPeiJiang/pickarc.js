import { fail } from "./errors.ts";
import type { PathOperation } from "./path-pipeline.ts";

export type Command = "ls" | "cat" | "cp";

export interface ParsedArgs {
  command: Command;
  archives: string[];
  operations: PathOperation[];
  ignoreChecksum: RegExp[];
  proxy: string | undefined;
  lockdown: string | undefined;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0];

  if (command !== "ls" && command !== "cat" && command !== "cp") {
    fail(command === undefined ? "missing command" : `unknown command: ${command}`);
  }

  const archives: string[] = [];
  const operations: PathOperation[] = [];
  const ignoreChecksum: RegExp[] = [];
  let proxy: string | undefined;
  let lockdown: string | undefined;
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

      case "--lockdown":
        lockdown = requireValue(argv, ++index, arg);
        break;

      case "--ignore-checksum":
        ignoreChecksum.push(compileRegex(requireValue(argv, ++index, arg), arg));
        break;

      case "--matches":
      case "--include": {
        const pattern = requireValue(argv, ++index, arg);
        operations.push({
          kind: "include",
          pattern,
          regex: compileRegex(pattern, arg),
        });
        break;
      }

      case "--exclude": {
        const pattern = requireValue(argv, ++index, arg);
        operations.push({
          kind: "exclude",
          pattern,
          regex: compileRegex(pattern, arg),
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
          pattern,
          regex: compileRegex(pattern, arg),
          keepExtension: false,
        });
        break;
      }

      case "--as-dir-keep-ext":
      case "--archive-is-dir-keep-ext": {
        const pattern = requireValue(argv, ++index, arg);
        operations.push({
          kind: "as-dir",
          pattern,
          regex: compileRegex(pattern, arg),
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
    lockdown,
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

function parseNonNegativeInteger(value: string, option: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    fail(`${option}: expected a non-negative integer`);
  }

  return Number(value);
}
