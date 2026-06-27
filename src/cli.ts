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
