import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { fail } from "./errors.ts";

export interface RangeSource {
  readonly label: string;
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
  prime?(offset: number, length: number): Promise<void>;
  close?(): Promise<void>;
}

export interface OpenSourceOptions {
  proxy: string | undefined;
  insecure: boolean;
}

export async function openRangeSource(
  input: string,
  options: OpenSourceOptions,
): Promise<RangeSource> {
  if (/^https?:\/\//i.test(input)) {
    return new ReadAheadRangeSource(new HttpRangeSource(input, options.proxy, options.insecure));
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

export class SubRangeSource implements RangeSource {
  readonly label: string;
  readonly #source: RangeSource;
  readonly #offset: number;
  readonly #size: number;

  constructor(source: RangeSource, offset: number, size: number, label: string) {
    this.#source = source;
    this.#offset = offset;
    this.#size = size;
    this.label = label;
  }

  async size(): Promise<number> {
    return this.#size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    assertRange(offset, length, this.#size, this.label);
    return this.#source.read(this.#offset + offset, length);
  }

  async prime(offset: number, length: number): Promise<void> {
    assertRange(offset, length, this.#size, this.label);
    await this.#source.prime?.(this.#offset + offset, length);
  }
}

interface CacheWindow {
  offset: number;
  bytes: Uint8Array;
  lastUsed: number;
}

interface PrefetchWindow {
  offset: number;
  length: number;
  promise: Promise<Uint8Array | Error>;
}

export class ReadAheadRangeSource implements RangeSource {
  readonly label: string;
  readonly #source: RangeSource;
  readonly #windowSize: number;
  readonly #maxWindows: number;
  readonly #maxPrefetches: number;
  #windows: CacheWindow[] = [];
  #prefetches: PrefetchWindow[] = [];
  #clock = 0;

  constructor(
    source: RangeSource,
    options?: { windowSize?: number; maxWindows?: number; maxPrefetches?: number },
  ) {
    this.#source = source;
    this.label = source.label;
    this.#windowSize = options?.windowSize ?? 4 * 1024 * 1024;
    this.#maxWindows = options?.maxWindows ?? 4;
    this.#maxPrefetches = options?.maxPrefetches ?? 0;
  }

  async size(): Promise<number> {
    return this.#source.size();
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const size = await this.size();
    assertRange(offset, length, size, this.label);

    if (length === 0) {
      return new Uint8Array();
    }

    const cached = this.findWindow(offset, length);

    if (cached !== undefined) {
      return cached;
    }

    if (length > this.#windowSize) {
      return this.#source.read(offset, length);
    }

    const prefetched = await this.findPrefetch(offset, length);

    if (prefetched !== undefined) {
      this.schedulePrefetch(prefetched.offset + prefetched.bytes.byteLength, size);
      return prefetched.bytes.slice(offset - prefetched.offset, offset - prefetched.offset + length);
    }

    const readLength = Math.min(this.#windowSize, size - offset);
    const bytes = await this.#source.read(offset, readLength);
    this.addWindow(offset, bytes);
    this.schedulePrefetch(offset + readLength, size);
    return bytes.slice(0, length);
  }

  async close(): Promise<void> {
    await this.#source.close?.();
  }

  async prime(offset: number, length: number): Promise<void> {
    const size = await this.size();
    assertRange(offset, length, size, this.label);

    if (length === 0 || this.findWindow(offset, length) !== undefined) {
      return;
    }

    this.addWindow(offset, await this.#source.read(offset, length));
  }

  private findWindow(offset: number, length: number): Uint8Array | undefined {
    for (const window of this.#windows) {
      const start = offset - window.offset;

      if (start >= 0 && start + length <= window.bytes.byteLength) {
        window.lastUsed = ++this.#clock;
        return window.bytes.slice(start, start + length);
      }
    }

    return undefined;
  }

  private async findPrefetch(
    offset: number,
    length: number,
  ): Promise<{ offset: number; bytes: Uint8Array } | undefined> {
    const prefetch = this.#prefetches.find(
      (item) => offset >= item.offset && offset + length <= item.offset + item.length,
    );

    if (prefetch === undefined) {
      return undefined;
    }

    const bytes = await prefetch.promise;

    if (bytes instanceof Error) {
      throw bytes;
    }

    return {
      offset: prefetch.offset,
      bytes,
    };
  }

  private schedulePrefetch(offset: number, size: number): void {
    if (this.#maxPrefetches <= 0 || offset >= size) {
      return;
    }

    if (this.findWindow(offset, 1) !== undefined) {
      return;
    }

    if (this.#prefetches.some((item) => offset >= item.offset && offset < item.offset + item.length)) {
      return;
    }

    while (this.#prefetches.length >= this.#maxPrefetches) {
      this.#prefetches.shift();
    }

    const length = Math.min(this.#windowSize, size - offset);
    const prefetch: PrefetchWindow = {
      offset,
      length,
      promise: this.#source.read(offset, length).then(
        (bytes) => {
          this.addWindow(offset, bytes);
          return bytes;
        },
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      ),
    };

    this.#prefetches.push(prefetch);
    prefetch.promise.finally(() => {
      const index = this.#prefetches.indexOf(prefetch);

      if (index !== -1) {
        this.#prefetches.splice(index, 1);
      }
    });
  }

  private addWindow(offset: number, bytes: Uint8Array): void {
    this.#windows.push({
      offset,
      bytes,
      lastUsed: ++this.#clock,
    });

    while (this.#windows.length > this.#maxWindows) {
      let oldestIndex = 0;

      for (let index = 1; index < this.#windows.length; index += 1) {
        if (this.#windows[index]!.lastUsed < this.#windows[oldestIndex]!.lastUsed) {
          oldestIndex = index;
        }
      }

      this.#windows.splice(oldestIndex, 1);
    }
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

interface HttpRequestOptions {
  method?: "HEAD" | "GET";
  headers?: Record<string, string>;
}

interface HttpRangeResponse {
  status: number;
  headers: Headers;
  body(): Promise<Uint8Array>;
}

abstract class BaseHttpRangeSource implements RangeSource {
  readonly label: string;
  #size: number | undefined;

  constructor(label: string) {
    this.label = label;
  }

  async size(): Promise<number> {
    if (this.#size !== undefined) {
      return this.#size;
    }

    const head = await this.request({ method: "HEAD" });
    const contentLength = head.headers.get("content-length");

    if (head.status >= 200 && head.status < 300 && contentLength !== null) {
      this.#size = parseContentLength(contentLength, this.label);
      return this.#size;
    }

    const probe = await this.request({
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
    await probe.body();
    return this.#size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const size = await this.size();
    assertRange(offset, length, size, this.label);

    if (length === 0) {
      return new Uint8Array();
    }

    const response = await this.request({
      headers: {
        range: `bytes=${offset}-${offset + length - 1}`,
      },
    });

    if (response.status === 206) {
      const bytes = await response.body();

      if (bytes.byteLength !== length) {
        fail(`${this.label}: short HTTP range read at offset ${offset}`);
      }

      return bytes;
    }

    if (response.status === 200 && offset === 0 && length === size) {
      const bytes = await response.body();

      if (bytes.byteLength !== length) {
        fail(`${this.label}: short HTTP read`);
      }

      return bytes;
    }

    fail(`${this.label}: server does not support required HTTP range request`);
  }

  protected abstract request(options: HttpRequestOptions): Promise<HttpRangeResponse>;
}

export class HttpRangeSource extends BaseHttpRangeSource {
  readonly label: string;
  readonly #url: string;
  readonly #proxy: string | undefined;
  readonly #insecure: boolean;

  constructor(url: string, proxy: string | undefined, insecure = false) {
    super(url);
    this.#url = url;
    this.#proxy = proxy;
    this.#insecure = insecure;
    this.label = url;
  }

  protected async request(options: HttpRequestOptions): Promise<HttpRangeResponse> {
    const headers = new Headers(options.headers);

    if (!headers.has("accept-encoding")) {
      headers.set("accept-encoding", "identity");
    }

    const requestInit: RequestInit = {
      headers,
      redirect: "follow",
    };

    if (options.method !== undefined) {
      requestInit.method = options.method;
    }

    if (this.#proxy !== undefined) {
      Object.assign(requestInit, { proxy: this.#proxy });
    }

    if (this.#insecure) {
      Object.assign(requestInit, {
        tls: {
          rejectUnauthorized: false,
        },
      });
    }

    const response = await fetch(this.#url, requestInit);

    return {
      status: response.status,
      headers: response.headers,
      body: async () => new Uint8Array(await response.arrayBuffer()),
    };
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
