import { afterEach, describe, expect, test } from "bun:test";
import {
  HttpRangeSource,
  ReadAheadRangeSource,
  SubRangeSource,
  type RangeSource,
} from "../src/range-source.ts";

const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
});

describe("HttpRangeSource", () => {
  test("requests identity encoding for byte ranges", async () => {
    const headersSeen: string[] = [];

    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      headersSeen.push(headers.get("accept-encoding") ?? "");

      if (init?.method === "HEAD") {
        return new Response(null, {
          headers: {
            "content-length": "4",
          },
        });
      }

      return new Response(new Uint8Array([2, 3]), {
        status: 206,
      });
    }) as typeof fetch;

    const source = new HttpRangeSource("https://example.test/archive.zip", undefined);

    expect(await source.size()).toBe(4);
    expect(Array.from(await source.read(1, 2))).toEqual([2, 3]);
    expect(headersSeen).toEqual(["identity", "identity"]);
  });

  test("passes proxy and insecure TLS options to fetch", async () => {
    const requestOptions: RequestInit[] = [];

    globalThis.fetch = (async (_input, init) => {
      requestOptions.push(init ?? {});

      return new Response(null, {
        headers: {
          "content-length": "4",
        },
      });
    }) as typeof fetch;

    const source = new HttpRangeSource(
      "https://example.test/archive.zip",
      "http://proxy.example:8080",
      true,
    );

    expect(await source.size()).toBe(4);
    expect(requestOptions[0]).toMatchObject({
      proxy: "http://proxy.example:8080",
      tls: {
        rejectUnauthorized: false,
      },
    });
  });

  test("serves nearby ranges from one read-ahead window", async () => {
    const source = new CountingRangeSource(new Uint8Array([1, 2, 3, 4, 5, 6]));
    const cached = new ReadAheadRangeSource(source, {
      windowSize: 4,
      maxWindows: 2,
      maxPrefetches: 0,
    });

    expect(Array.from(await cached.read(1, 1))).toEqual([2]);
    expect(Array.from(await cached.read(2, 2))).toEqual([3, 4]);
    expect(source.reads).toEqual([{ offset: 1, length: 4 }]);
  });

  test("prefetches the next adjacent read-ahead window", async () => {
    const source = new CountingRangeSource(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const cached = new ReadAheadRangeSource(source, {
      windowSize: 4,
      maxWindows: 4,
      maxPrefetches: 1,
    });

    expect(Array.from(await cached.read(0, 1))).toEqual([1]);
    await Bun.sleep(10);
    expect(Array.from(await cached.read(4, 2))).toEqual([5, 6]);
    expect(source.reads).toEqual([
      { offset: 0, length: 4 },
      { offset: 4, length: 4 },
    ]);
  });

  test("maps sub-range reads and primes to the parent source", async () => {
    const source = new CountingRangeSource(new Uint8Array([1, 2, 3, 4, 5, 6]));
    const nested = new SubRangeSource(source, 2, 3, "nested");

    expect(await nested.size()).toBe(3);
    expect(Array.from(await nested.read(1, 2))).toEqual([4, 5]);
    await nested.prime(0, 1);
    expect(source.reads).toEqual([
      { offset: 3, length: 2 },
      { offset: 2, length: 1 },
    ]);
  });
});

class CountingRangeSource implements RangeSource {
  readonly label = "counting";
  readonly reads: Array<{ offset: number; length: number }> = [];
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  async size(): Promise<number> {
    return this.#bytes.byteLength;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.reads.push({ offset, length });
    return this.#bytes.slice(offset, offset + length);
  }

  async prime(offset: number, length: number): Promise<void> {
    this.reads.push({ offset, length });
  }
}
