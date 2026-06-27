import { fail } from "./errors.ts";
import type { ParsedArgs } from "./options.ts";
import type { PathCandidate } from "./path-pipeline.ts";
import { formatBytes } from "./progress.ts";

interface SizeSummary {
  files: number;
  directories: number;
  entries: number;
  compressedSize: number;
  uncompressedSize: number;
}

interface SizeSummaryGroup extends SizeSummary {
  key: string;
}

interface StatJson {
  path: string;
  sourcePath: string;
  archive: string;
  kind: "file" | "directory";
  compressionMethod: number | undefined;
  compressionName: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: string | undefined;
  isSymlink: boolean;
  localHeaderOffset: number | undefined;
}

export async function diskUsage(
  candidates: readonly PathCandidate[],
  options: ParsedArgs,
): Promise<void> {
  if (options.jsonl) {
    fail(`du: --jsonl is only supported by stat`);
  }

  switch (options.groupBy) {
    case "none": {
      if (options.depth !== undefined || options.all) {
        fail(`du: --depth and --all require --by dir`);
      }

      const summary = summarizeCandidates(candidates);

      if (options.json) {
        printJson({
          ...summary,
          archives: countArchives(candidates),
        });
      } else {
        printDuTable([summary], undefined, options.bytes);
      }

      break;
    }

    case "archive": {
      if (options.depth !== undefined || options.all) {
        fail(`du: --depth and --all require --by dir`);
      }

      const groups = summarizeByArchive(candidates);

      if (options.json) {
        printJson(groups.map((group) => summaryGroupJson("archive", group)));
      } else {
        printDuTable(groups, "archive", options.bytes);
      }

      break;
    }

    case "dir": {
      const groups = filterDirectoryGroups(
        summarizeByDirectory(candidates),
        options.all ? undefined : options.depth ?? 1,
      );

      if (options.json) {
        printJson(groups.map((group) => summaryGroupJson("path", group)));
      } else {
        printDuTable(groups, "path", options.bytes);
      }

      break;
    }
  }
}

export async function statEntries(
  candidates: readonly PathCandidate[],
  options: ParsedArgs,
): Promise<void> {
  if (options.groupBy !== "none" || options.depth !== undefined || options.all) {
    fail(`stat: --by, --depth, and --all are only supported by du`);
  }

  if (options.json && options.jsonl) {
    fail(`stat: use either --json or --jsonl`);
  }

  if (options.json) {
    printJson(candidatesToStatJson(candidates));
    return;
  }

  if (options.jsonl) {
    for (let index = 0; index < candidates.length; index += 1) {
      console.log(JSON.stringify(candidateToStatJson(candidates[index]!)));
    }
    return;
  }

  printStatTable(candidates, options.bytes);
}

function summarizeCandidates(candidates: readonly PathCandidate[]): SizeSummary {
  const summary = emptySummary();

  for (let index = 0; index < candidates.length; index += 1) {
    addCandidate(summary, candidates[index]!);
  }

  return summary;
}

function summarizeByArchive(candidates: readonly PathCandidate[]): SizeSummaryGroup[] {
  const groups: SizeSummaryGroup[] = [];
  const indexes: Record<string, number> = Object.create(null) as Record<string, number>;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const key = candidate.archiveLabel;
    let groupIndex = indexes[key];

    if (groupIndex === undefined) {
      groupIndex = groups.length;
      indexes[key] = groupIndex;
      groups.push({
        key,
        ...emptySummary(),
      });
    }

    addCandidate(groups[groupIndex]!, candidate);
  }

  groups.sort((left, right) => left.key.localeCompare(right.key));
  return groups;
}

function summarizeByDirectory(candidates: readonly PathCandidate[]): SizeSummaryGroup[] {
  const groups: SizeSummaryGroup[] = [];
  const indexes: Record<string, number> = Object.create(null) as Record<string, number>;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const directories = recursiveGroupDirectories(candidate.path, candidate.kind);

    for (let dirIndex = 0; dirIndex < directories.length; dirIndex += 1) {
      const key = directories[dirIndex]!;
      let groupIndex = indexes[key];

      if (groupIndex === undefined) {
        groupIndex = groups.length;
        indexes[key] = groupIndex;
        groups.push({
          key,
          ...emptySummary(),
        });
      }

      addCandidate(groups[groupIndex]!, candidate);
    }
  }

  groups.sort((left, right) => {
    if (left.key === ".") {
      return right.key === "." ? 0 : -1;
    }

    if (right.key === ".") {
      return 1;
    }

    return left.key.localeCompare(right.key);
  });
  return groups;
}

function filterDirectoryGroups(
  groups: readonly SizeSummaryGroup[],
  maxDepth: number | undefined,
): SizeSummaryGroup[] {
  if (maxDepth === undefined) {
    return [...groups];
  }

  const filtered: SizeSummaryGroup[] = [];

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;

    if (directoryDepth(group.key) <= maxDepth) {
      filtered.push(group);
    }
  }

  return filtered;
}

function recursiveGroupDirectories(path: string, kind: PathCandidate["kind"]): string[] {
  const target = kind === "directory" ? path : parentDirectory(path);
  const groups = ["."];

  if (target === ".") {
    return groups;
  }

  const parts = target.split("/");
  let current = "";

  for (let index = 0; index < parts.length; index += 1) {
    current = current === "" ? parts[index]! : `${current}/${parts[index]!}`;
    groups.push(current);
  }

  return groups;
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function directoryDepth(path: string): number {
  if (path === ".") {
    return 0;
  }

  let depth = 1;

  for (let index = 0; index < path.length; index += 1) {
    if (path.charCodeAt(index) === 47) {
      depth += 1;
    }
  }

  return depth;
}

function emptySummary(): SizeSummary {
  return {
    files: 0,
    directories: 0,
    entries: 0,
    compressedSize: 0,
    uncompressedSize: 0,
  };
}

function addCandidate(summary: SizeSummary, candidate: PathCandidate): void {
  summary.entries += 1;

  if (candidate.kind === "file") {
    summary.files += 1;
    summary.compressedSize += candidate.compressedSize;
    summary.uncompressedSize += candidate.uncompressedSize;
  } else {
    summary.directories += 1;
  }
}

function countArchives(candidates: readonly PathCandidate[]): number {
  const seen: Record<string, true> = Object.create(null) as Record<string, true>;
  let count = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const label = candidates[index]!.archiveLabel;

    if (seen[label] !== true) {
      seen[label] = true;
      count += 1;
    }
  }

  return count;
}

function summaryGroupJson(
  keyName: "archive" | "path",
  group: SizeSummaryGroup,
): Record<string, number | string> {
  return {
    [keyName]: group.key,
    files: group.files,
    directories: group.directories,
    entries: group.entries,
    compressedSize: group.compressedSize,
    uncompressedSize: group.uncompressedSize,
  };
}

function candidatesToStatJson(candidates: readonly PathCandidate[]): StatJson[] {
  const output: StatJson[] = new Array(candidates.length);

  for (let index = 0; index < candidates.length; index += 1) {
    output[index] = candidateToStatJson(candidates[index]!);
  }

  return output;
}

function candidateToStatJson(candidate: PathCandidate): StatJson {
  return {
    path: candidate.path,
    sourcePath: candidate.sourcePath,
    archive: candidate.archiveLabel,
    kind: candidate.kind,
    compressionMethod: candidate.compressionMethod,
    compressionName: compressionName(candidate.compressionMethod),
    compressedSize: candidate.kind === "file" ? candidate.compressedSize : 0,
    uncompressedSize: candidate.kind === "file" ? candidate.uncompressedSize : 0,
    crc32: formatCrc32(candidate.crc32),
    isSymlink: candidate.isSymlink,
    localHeaderOffset: candidate.physicalOffset,
  };
}

function printDuTable(
  rows: readonly (SizeSummary | SizeSummaryGroup)[],
  keyHeader: "archive" | "path" | undefined,
  rawBytes: boolean,
): void {
  const tableRows: string[][] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const tableRow = [
      formatSize(row.compressedSize, rawBytes),
      formatSize(row.uncompressedSize, rawBytes),
      row.files.toLocaleString("en-US"),
      row.directories.toLocaleString("en-US"),
      row.entries.toLocaleString("en-US"),
    ];

    if (keyHeader !== undefined) {
      tableRow.push((row as SizeSummaryGroup).key);
    }

    tableRows.push(tableRow);
  }

  printTable(
    keyHeader === undefined
      ? ["compressed", "uncompressed", "files", "dirs", "entries"]
      : ["compressed", "uncompressed", "files", "dirs", "entries", keyHeader],
    tableRows,
  );
}

function printStatTable(candidates: readonly PathCandidate[], rawBytes: boolean): void {
  const rows: string[][] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    rows.push([
      formatSize(candidate.kind === "file" ? candidate.uncompressedSize : 0, rawBytes),
      formatSize(candidate.kind === "file" ? candidate.compressedSize : 0, rawBytes),
      compressionName(candidate.compressionMethod),
      candidate.kind,
      candidate.path,
    ]);
  }

  printTable(["uncompressed", "compressed", "method", "kind", "path"], rows);
}

function printTable(headers: readonly string[], rows: readonly string[][]): void {
  const widths = new Array<number>(headers.length);

  for (let index = 0; index < headers.length; index += 1) {
    widths[index] = headers[index]!.length;
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;

    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      widths[columnIndex] = Math.max(widths[columnIndex]!, row[columnIndex]!.length);
    }
  }

  const lines = [formatTableRow(headers, widths)];

  for (let index = 0; index < rows.length; index += 1) {
    lines.push(formatTableRow(rows[index]!, widths));
  }

  console.log(lines.join("\n"));
}

function formatTableRow(row: readonly string[], widths: readonly number[]): string {
  const columns = new Array<string>(row.length);

  for (let index = 0; index < row.length; index += 1) {
    columns[index] = row[index]!.padEnd(widths[index]!);
  }

  return columns.join("  ").trimEnd();
}

function formatSize(size: number, rawBytes: boolean): string {
  return rawBytes ? String(size) : formatBytes(size);
}

function compressionName(method: number | undefined): string {
  switch (method) {
    case 0:
      return "store";

    case 8:
      return "deflate";

    case undefined:
      return "none";

    default:
      return `method-${method}`;
  }
}

function formatCrc32(value: number | undefined): string | undefined {
  return value === undefined ? undefined : value.toString(16).padStart(8, "0");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
