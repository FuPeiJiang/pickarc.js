import { afterEach, describe, expect, test } from "bun:test";
import { HttpRangeSource } from "../src/range-source.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
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
});
