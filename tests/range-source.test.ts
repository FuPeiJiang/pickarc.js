import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import http2 from "node:http2";
import { Http1RangeSource, Http2RangeSource, HttpRangeSource } from "../src/range-source.ts";

const originalFetch = globalThis.fetch;
const servers: Array<{ close(callback: () => void): void }> = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  const active = servers.splice(0);

  await Promise.all(
    active.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(resolve);
        }),
    ),
  );
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

  test("reads ranges over explicit HTTP/1", async () => {
    const url = await startHttp1RangeServer(new Uint8Array([1, 2, 3, 4, 5]));
    const source = new Http1RangeSource(url);

    try {
      expect(await source.size()).toBe(5);
      expect(Array.from(await source.read(1, 3))).toEqual([2, 3, 4]);
    } finally {
      await source.close();
    }
  });

  test("reads ranges over explicit HTTP/2", async () => {
    const url = await startHttp2RangeServer(new Uint8Array([1, 2, 3, 4, 5]));
    const source = new Http2RangeSource(url);

    try {
      expect(await source.size()).toBe(5);
      expect(Array.from(await source.read(1, 3))).toEqual([2, 3, 4]);
    } finally {
      await source.close();
    }
  });
});

async function startHttp1RangeServer(data: Uint8Array): Promise<string> {
  const server = http.createServer((request, response) => {
    const range = request.headers.range;

    response.setHeader("accept-ranges", "bytes");

    if (request.method === "HEAD") {
      response.writeHead(200, {
        "content-length": data.byteLength,
      });
      response.end();
      return;
    }

    const slice = sliceRange(data, Array.isArray(range) ? range[0] : range);
    response.writeHead(206, {
      "content-length": slice.bytes.byteLength,
      "content-range": `bytes ${slice.start}-${slice.end}/${data.byteLength}`,
    });
    response.end(slice.bytes);
  });
  servers.push(server);
  await listen(server);
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("unexpected HTTP/1 server address");
  }

  return `http://127.0.0.1:${address.port}/archive.zip`;
}

async function startHttp2RangeServer(data: Uint8Array): Promise<string> {
  const server = http2.createServer();

  server.on("stream", (stream, headers) => {
    const serverStream = stream as http2.ServerHttp2Stream;
    const method = headers[":method"];
    const range = headers.range;

    if (method === "HEAD") {
      serverStream.respond({
        ":status": 200,
        "accept-ranges": "bytes",
        "content-length": data.byteLength,
      });
      serverStream.end();
      return;
    }

    const rangeValue = Array.isArray(range) ? range[0] : range;
    const slice = sliceRange(data, typeof rangeValue === "string" ? rangeValue : undefined);
    serverStream.respond({
      ":status": 206,
      "accept-ranges": "bytes",
      "content-length": slice.bytes.byteLength,
      "content-range": `bytes ${slice.start}-${slice.end}/${data.byteLength}`,
    });
    serverStream.end(slice.bytes);
  });

  servers.push(server);
  await listen(server);
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("unexpected HTTP/2 server address");
  }

  return `http://127.0.0.1:${address.port}/archive.zip`;
}

function sliceRange(
  data: Uint8Array,
  range: string | undefined,
): {
  bytes: Uint8Array;
  start: number;
  end: number;
} {
  const match = range?.match(/^bytes=(\d+)-(\d+)$/);

  if (match === undefined || match === null) {
    throw new Error(`expected range header`);
  }

  const start = Number(match[1]);
  const end = Number(match[2]);

  return {
    bytes: data.slice(start, end + 1),
    start,
    end,
  };
}

async function listen(server: http.Server | http2.Http2Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}
