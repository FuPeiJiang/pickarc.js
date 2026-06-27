import { fail } from "./errors.ts";

export interface PathMatcher {
  source: "regex" | "glob";
  pattern: string;
  matches(path: string): boolean;
}

export function regexMatcher(pattern: string, option: string): PathMatcher {
  let regex: RegExp;

  try {
    regex = new RegExp(pattern);
  } catch (error) {
    fail(`${option}: invalid regex ${JSON.stringify(pattern)}: ${String(error)}`);
  }

  return {
    source: "regex",
    pattern,
    matches(path) {
      regex.lastIndex = 0;
      return regex.test(path);
    },
  };
}

export function globMatcher(pattern: string, option: string): PathMatcher {
  let glob: Bun.Glob;

  try {
    glob = new Bun.Glob(pattern);
  } catch (error) {
    fail(`${option}: invalid glob ${JSON.stringify(pattern)}: ${String(error)}`);
  }

  return {
    source: "glob",
    pattern,
    matches(path) {
      return glob.match(path);
    },
  };
}

export function matchesAny(matchers: readonly PathMatcher[], path: string): boolean {
  return matchers.some((matcher) => matcher.matches(path));
}
