#!/usr/bin/env bun

import { PickarcError } from "./errors.ts";
import { runCommand } from "./commands.ts";
import { parseArgs } from "./options.ts";

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log("pickarc 0.1.0");
    return;
  }

  await runCommand(parseArgs(argv));
}

function printHelp(): void {
  console.log(`pickarc

Usage:
  pickarc ls [options] <archive...>
  pickarc cat [options] <archive...>
  pickarc cp [options] <archive...>

Commands:
  ls    List final paths after rewrite/filter rules
  cat   Write selected file contents to stdout
  cp    Copy selected files to their final paths

Options:
  --proxy <url>
  --http <fetch|http1|http2>
  --lockdown <path>
  --progress <auto|always|never>, --no-progress
  --ignore-checksum <regex>
  --include <regex>, --match <regex>, --matches <regex>
  --include-glob <glob>, --match-glob <glob>, --matches-glob <glob>
  --or <regex>, --or-glob <glob>
  --exclude <regex>
  --exclude-glob <glob>
  --replace <regex> <replacement>
  --strip-components <n>, --cut-prefix <n>
  --flatten
  --as-dir <regex>, --archive-is-dir <regex>
  --as-dir-glob <glob>, --archive-is-dir-glob <glob>
  --as-dir-keep-ext <regex>, --archive-is-dir-keep-ext <regex>
  --as-dir-keep-ext-glob <glob>, --archive-is-dir-keep-ext-glob <glob>
`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof PickarcError) {
      console.error(`pickarc: ${error.message}`);
      process.exit(1);
    }

    throw error;
  }
}
