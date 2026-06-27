import type { ProgressMode } from "./options.ts";

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  clearLine: "\x1b[2K",
};

export interface ProgressStream {
  columns?: number;
  isTTY?: boolean;
  write(data: string): boolean;
}

export interface CopyProgressOptions {
  mode: ProgressMode;
  stream?: ProgressStream;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface CopyProgressTotals {
  filesTotal: number;
  bytesTotal: number;
}

export interface CopyProgressFile {
  path: string;
  bytesTotal: number;
}

export interface CopyProgressSnapshot {
  filePath: string;
  fileBytesDone: number;
  fileBytesTotal: number;
  totalBytesDone: number;
  totalBytesTotal: number;
  filesDone: number;
  filesTotal: number;
  bytesPerSecond: number;
}

export interface RenderProgressOptions {
  color: boolean;
  columns: number;
}

export class CopyProgress {
  readonly enabled: boolean;
  readonly #stream: ProgressStream;
  readonly #live: boolean;
  readonly #color: boolean;
  readonly #now: () => number;
  #filesTotal = 0;
  #bytesTotal = 0;
  #filesDone = 0;
  #bytesDone = 0;
  #filePath = "";
  #fileBytesTotal = 0;
  #fileBytesDone = 0;
  #fileStartedAt = 0;
  #lastRenderAt = 0;
  #linesRendered = 0;

  constructor(options: CopyProgressOptions) {
    this.#stream = options.stream ?? process.stderr;
    this.#live = Boolean(this.#stream.isTTY);
    this.enabled =
      options.mode === "always" || (options.mode === "auto" && Boolean(this.#stream.isTTY));
    this.#color = this.enabled && shouldUseColor(this.#stream, options.env ?? process.env);
    this.#now = options.now ?? (() => Date.now());
  }

  start(totals: CopyProgressTotals): void {
    if (!this.enabled) {
      return;
    }

    this.#filesTotal = totals.filesTotal;
    this.#bytesTotal = totals.bytesTotal;
  }

  startFile(file: CopyProgressFile): void {
    if (!this.enabled) {
      return;
    }

    this.#filePath = file.path;
    this.#fileBytesTotal = file.bytesTotal;
    this.#fileBytesDone = 0;
    this.#fileStartedAt = this.#now();
    this.#render(true);
  }

  advanceFile(bytes: number): void {
    if (!this.enabled) {
      return;
    }

    this.#fileBytesDone += bytes;
    this.#bytesDone += bytes;
    this.#render(false);
  }

  finishFile(): void {
    if (!this.enabled) {
      return;
    }

    this.#fileBytesDone = this.#fileBytesTotal;
    this.#filesDone += 1;
    this.#render(true);
  }

  finish(): void {
    return;
  }

  #render(force: boolean): void {
    const now = this.#now();

    if (!force && now - this.#lastRenderAt < 80) {
      return;
    }

    this.#lastRenderAt = now;

    const frame = renderProgressFrame(
      {
        filePath: this.#filePath === "" ? "copy" : this.#filePath,
        fileBytesDone: this.#fileBytesDone,
        fileBytesTotal: this.#fileBytesTotal,
        totalBytesDone: this.#bytesDone,
        totalBytesTotal: this.#bytesTotal,
        filesDone: this.#filesDone,
        filesTotal: this.#filesTotal,
        bytesPerSecond: this.#fileRate(now),
      },
      {
        color: this.#color,
        columns: this.#stream.columns ?? 80,
      },
    );

    if (this.#live && this.#linesRendered > 0) {
      this.#stream.write(`\x1b[${this.#linesRendered}A`);
    }

    const lines = frame.split("\n");

    if (this.#live) {
      for (const line of lines) {
        this.#stream.write(`${ansi.clearLine}${line}\n`);
      }
    } else {
      this.#stream.write(`${frame}\n`);
    }

    this.#linesRendered = lines.length;
  }

  #fileRate(now: number): number {
    const elapsedSeconds = Math.max((now - this.#fileStartedAt) / 1000, 0.001);
    return this.#fileBytesDone / elapsedSeconds;
  }
}

export function renderProgressFrame(
  snapshot: CopyProgressSnapshot,
  options: RenderProgressOptions,
): string {
  const color = colorSet(options.color);
  const fileSize = formatByteProgress(snapshot.fileBytesDone, snapshot.fileBytesTotal);
  const totalSize = formatByteProgress(snapshot.totalBytesDone, snapshot.totalBytesTotal);
  const sizeWidth = Math.max(fileSize.length, totalSize.length);
  const filePercent = formatPercent(snapshot.fileBytesDone, snapshot.fileBytesTotal);
  const totalPercent = formatPercent(snapshot.totalBytesDone, snapshot.totalBytesTotal);
  const speed = `${formatBytes(snapshot.bytesPerSecond)}/s`;
  const count = `${snapshot.filesDone.toLocaleString("en-US")}/${snapshot.filesTotal.toLocaleString("en-US")}`;
  const barWidth = chooseBarWidth(options.columns, sizeWidth, Math.max(speed.length, count.length));
  const path = truncateLeft(snapshot.filePath, Math.max(12, options.columns));

  return [
    `${color.bold}${path}${color.reset}`,
    `    ${color.dim}${fileSize.padEnd(sizeWidth)}${color.reset}  ${renderBar(
      snapshot.fileBytesDone,
      snapshot.fileBytesTotal,
      barWidth,
      color,
    )}  ${color.bold}${filePercent}${color.reset}  ${color.dim}${speed}${color.reset}`,
    `  ${color.bold}total${color.reset}`,
    `    ${color.dim}${totalSize.padEnd(sizeWidth)}${color.reset}  ${renderBar(
      snapshot.totalBytesDone,
      snapshot.totalBytesTotal,
      barWidth,
      color,
    )}  ${color.bold}${totalPercent}${color.reset}  ${color.dim}${count}${color.reset}`,
  ].join("\n");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`;
  }

  if (value >= 100) {
    return `${Math.round(value)} ${units[unitIndex]}`;
  }

  return `${value.toFixed(value >= 1 ? 1 : 2)} ${units[unitIndex]}`;
}

function renderBar(done: number, total: number, width: number, color: ReturnType<typeof colorSet>): string {
  const ratio = total <= 0 ? 1 : Math.max(0, Math.min(1, done / total));
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  return `${color.dim}[${color.reset}${color.cyan}${"#".repeat(filled)}${color.reset}${color.dim}${"-".repeat(empty)}]${color.reset}`;
}

function formatByteProgress(done: number, total: number): string {
  return `${formatBytes(done)} / ${formatBytes(total)}`;
}

function formatPercent(done: number, total: number): string {
  const ratio = total <= 0 ? 1 : Math.max(0, Math.min(1, done / total));
  return `${Math.round(ratio * 100).toString().padStart(3, " ")}%`;
}

function chooseBarWidth(columns: number, sizeWidth: number, suffixWidth: number): number {
  const fixed = 4 + sizeWidth + 2 + 2 + 2 + 4 + 2 + suffixWidth;
  return Math.max(10, Math.min(20, columns - fixed));
}

function truncateLeft(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 3) {
    return ".".repeat(width);
  }

  return `...${value.slice(-(width - 3))}`;
}

function colorSet(color: boolean): {
  reset: string;
  bold: string;
  cyan: string;
  dim: string;
} {
  if (!color) {
    return {
      reset: "",
      bold: "",
      cyan: "",
      dim: "",
    };
  }

  return {
    reset: ansi.reset,
    bold: ansi.bold,
    cyan: ansi.cyan,
    dim: ansi.dim,
  };
}

function shouldUseColor(stream: ProgressStream, env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR !== undefined) {
    return false;
  }

  return Boolean(stream.isTTY) || env.FORCE_COLOR !== undefined;
}
