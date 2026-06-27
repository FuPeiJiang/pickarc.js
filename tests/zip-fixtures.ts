import { deflateRawSync } from "node:zlib";
import { crc32 } from "../src/crc32.ts";

export interface ZipFixtureEntry {
  path: string;
  data?: string | Uint8Array;
  method?: 0 | 8;
  externalAttributes?: number;
  crc32?: number;
}

export function makeZip(entries: readonly ZipFixtureEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const centralDirectory: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path);
    const data = toBytes(entry.data ?? "");
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const checksum = entry.crc32 ?? crc32(data);
    const localOffset = offset;
    const local = new Uint8Array(30 + name.byteLength);
    const localView = viewOf(local);

    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, compressed.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    chunks.push(local, compressed);
    offset += local.byteLength + compressed.byteLength;

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = viewOf(central);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 0x031e, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, compressed.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(38, entry.externalAttributes ?? defaultExternalAttributes(entry.path));
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralDirectory.push(central);
  }

  const centralDirectoryOffset = offset;
  let centralDirectorySize = 0;

  for (const central of centralDirectory) {
    chunks.push(central);
    offset += central.byteLength;
    centralDirectorySize += central.byteLength;
  }

  const eocd = new Uint8Array(22);
  const eocdView = viewOf(eocd);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralDirectorySize, true);
  eocdView.setUint32(16, centralDirectoryOffset, true);
  chunks.push(eocd);

  return concat(chunks);
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

function defaultExternalAttributes(path: string): number {
  return path.endsWith("/") ? 0o040755 << 16 : 0o100644 << 16;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
