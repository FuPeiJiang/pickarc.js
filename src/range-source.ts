import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { fail } from "./errors.ts";

export interface RangeSource {
  readonly label: string;
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

export interface OpenSourceOptions {
  proxy: string | undefined;
}

export async function openRangeSource(
  input: string,
  options: OpenSourceOptions,
): Promise<RangeSource> {
  if (/^https?:\/\//i.test(input)) {
    return new HttpRangeSource(input, options.proxy);
  }

  return FileRangeSource.open(input);
}

export class BufferRangeSource implements RangeSource {
  readonly label: string;
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array, label = "buffer") {
    this.#bytes = bytes;
    this.label = label;
  }

  async size(): Promise<number> {
    return this.#bytes.byteLength;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    assertRange(offset, length, this.#bytes.byteLength, this.label);
    return this.#bytes.slice(offset, offset + length);
  }
}

export class FileRangeSource implements RangeSource {
  readonly label: string;
  readonly #file: FileHandle;
  readonly #size: number;

  private constructor(label: string, file: FileHandle, size: number) {
    this.label = label;
    this.#file = file;
    this.#size = size;
  }

  static async open(path: string): Promise<FileRangeSource> {
    const info = await stat(path);

    if (!info.isFile()) {
      fail(`${path}: expected a regular file`);
    }

    return new FileRangeSource(path, await open(path, "r"), info.size);
  }

  async size(): Promise<number> {
    return this.#size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    assertRange(offset, length, this.#size, this.label);

    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.#file.read(buffer, 0, length, offset);

    if (bytesRead !== length) {
      fail(`${this.label}: short read at offset ${offset}`);
    }

    return buffer;
  }

  async close(): Promise<void> {
    await this.#file.close();
  }
}

export class HttpRangeSource implements RangeSource {
  readonly label: string;
  readonly #url: string;
  readonly #proxy: string | undefined;
  #size: number | undefined;

  constructor(url: string, proxy: string | undefined) {
    this.#url = url;
    this.#proxy = proxy;
    this.label = url;
  }

  async size(): Promise<number> {
    if (this.#size !== undefined) {
      return this.#size;
    }

    const head = await this.fetch({ method: "HEAD" });
    const contentLength = head.headers.get("content-length");

    if (head.ok && contentLength !== null) {
      this.#size = parseContentLength(contentLength, this.label);
      return this.#size;
    }

    const probe = await this.fetch({
      headers: {
        range: "bytes=0-0",
      },
    });

    if (probe.status !== 206) {
      fail(`${this.label}: server did not provide a size or range response`);
    }

    const range = probe.headers.get("content-range");
    const match = range?.match(/^bytes 0-0\/(\d+)$/);

    if (match === undefined || match === null) {
      fail(`${this.label}: invalid Content-Range header`);
    }

    this.#size = parseContentLength(match[1]!, this.label);
    await probe.arrayBuffer();
    return this.#size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const size = await this.size();
    assertRange(offset, length, size, this.label);

    if (length === 0) {
      return new Uint8Array();
    }

    const response = await this.fetch({
      headers: {
        range: `bytes=${offset}-${offset + length - 1}`,
      },
    });

    if (response.status === 206) {
      const bytes = new Uint8Array(await response.arrayBuffer());

      if (bytes.byteLength !== length) {
        fail(`${this.label}: short HTTP range read at offset ${offset}`);
      }

      return bytes;
    }

    if (response.status === 200 && offset === 0 && length === size) {
      const bytes = new Uint8Array(await response.arrayBuffer());

      if (bytes.byteLength !== length) {
        fail(`${this.label}: short HTTP read`);
      }

      return bytes;
    }

    fail(`${this.label}: server does not support required HTTP range request`);
  }

  private async fetch(init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);

    if (!headers.has("accept-encoding")) {
      headers.set("accept-encoding", "identity");
    }

    const requestInit: RequestInit = {
      ...init,
      headers,
      redirect: "follow",
    };

    if (this.#proxy !== undefined) {
      Object.assign(requestInit, { proxy: this.#proxy });
    }

    return fetch(this.#url, requestInit);
  }
}

function assertRange(offset: number, length: number, size: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    fail(`${label}: invalid range`);
  }

  if (offset + length > size) {
    fail(`${label}: range exceeds source size`);
  }
}

function parseContentLength(value: string, label: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    fail(`${label}: invalid content length`);
  }

  const size = Number(value);

  if (!Number.isSafeInteger(size)) {
    fail(`${label}: content length exceeds safe integer range`);
  }

  return size;
}
