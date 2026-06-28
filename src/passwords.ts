import { readFile } from "node:fs/promises";
import { fail } from "./errors.ts";
import type { PasswordRule, PasswordSource } from "./options.ts";

export interface PasswordResolverOptions {
  fallback: PasswordSource | undefined;
  rules: readonly PasswordRule[];
}

export class PasswordResolver {
  readonly #fallback: PasswordSource | undefined;
  readonly #rules: readonly PasswordRule[];
  readonly #cache: Record<string, Promise<string>> = Object.create(null) as Record<string, Promise<string>>;

  constructor(options: PasswordResolverOptions) {
    this.#fallback = options.fallback;
    this.#rules = options.rules;
  }

  async resolve(path: string): Promise<string | undefined> {
    for (let index = 0; index < this.#rules.length; index += 1) {
      const rule = this.#rules[index]!;

      if (rule.matcher.matches(path)) {
        return this.readSource(rule.source);
      }
    }

    return this.#fallback === undefined ? undefined : this.readSource(this.#fallback);
  }

  private readSource(source: PasswordSource): Promise<string> {
    const key = passwordSourceKey(source);
    let cached = this.#cache[key];

    if (cached === undefined) {
      cached = readPasswordSource(source);
      this.#cache[key] = cached;
    }

    return cached;
  }
}

function passwordSourceKey(source: PasswordSource): string {
  switch (source.kind) {
    case "literal":
      return `literal\0${source.value}`;

    case "file":
      return `file\0${source.path}`;

    case "env":
      return `env\0${source.name}`;
  }
}

async function readPasswordSource(source: PasswordSource): Promise<string> {
  switch (source.kind) {
    case "literal":
      return source.value;

    case "file":
      return stripOneTrailingLineEnding(await readFile(source.path, "utf8"));

    case "env": {
      const value = process.env[source.name];

      if (value === undefined) {
        fail(`--password-env: environment variable ${source.name} is not set`);
      }

      return value;
    }
  }
}

function stripOneTrailingLineEnding(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }

  if (value.endsWith("\n") || value.endsWith("\r")) {
    return value.slice(0, -1);
  }

  return value;
}
