import { inflateRawSync } from "node:zlib";
import { crc32 } from "./crc32.ts";
import { fail } from "./errors.ts";
import { BufferRangeSource, type RangeSource } from "./range-source.ts";
import { normalizeArchivePath } from "./path-utils.ts";

const eocdSignature = 0x06054b50;
const zip64EocdSignature = 0x06064b50;
const zip64LocatorSignature = 0x07064b50;
const centralDirectorySignature = 0x02014b50;
const localFileSignature = 0x04034b50;
const maxUint16 = 0xffff;
const maxUint32 = 0xffffffff;

export interface ZipEntry {
  readonly id: string;
  readonly archiveLabel: string;
  readonly index: number;
  readonly path: string;
  readonly rawPath: string;
  readonly flags: number;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly externalAttributes: number;
  readonly kind: "file" | "directory";
  readonly isSymlink: boolean;
}

export interface ReadEntryOptions {
  checkCrc: boolean;
}

interface CentralDirectoryInfo {
  offset: number;
  size: number;
  entries: number;
}

export class ZipArchive {
  readonly label: string;
  readonly #source: RangeSource;
  #entries: ZipEntry[] | undefined;

  constructor(source: RangeSource, label = source.label) {
    this.#source = source;
    this.label = label;
  }

  static fromBuffer(bytes: Uint8Array, label = "buffer.zip"): ZipArchive {
    return new ZipArchive(new BufferRangeSource(bytes, label), label);
  }

  async entries(): Promise<ZipEntry[]> {
    if (this.#entries !== undefined) {
      return this.#entries;
    }

    const info = await this.readCentralDirectoryInfo();
    const directory = await this.#source.read(info.offset, info.size);
    const view = viewOf(directory);
    const entries: ZipEntry[] = [];
    let cursor = 0;

    for (let index = 0; index < info.entries; index += 1) {
      if (cursor + 46 > directory.byteLength) {
        fail(`${this.label}: truncated central directory`);
      }

      if (view.getUint32(cursor, true) !== centralDirectorySignature) {
        fail(`${this.label}: invalid central directory entry`);
      }

      const flags = view.getUint16(cursor + 8, true);
      const compressionMethod = view.getUint16(cursor + 10, true);
      const expectedCrc32 = view.getUint32(cursor + 16, true);
      const compressedSize32 = view.getUint32(cursor + 20, true);
      const uncompressedSize32 = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const diskStart = view.getUint16(cursor + 34, true);
      const externalAttributes = view.getUint32(cursor + 38, true);
      const localHeaderOffset32 = view.getUint32(cursor + 42, true);
      const variableStart = cursor + 46;
      const variableEnd = variableStart + nameLength + extraLength + commentLength;

      if (variableEnd > directory.byteLength) {
        fail(`${this.label}: truncated central directory entry`);
      }

      if (diskStart !== 0 && diskStart !== maxUint16) {
        fail(`${this.label}: multi-disk ZIP archives are not supported`);
      }

      const nameBytes = directory.slice(variableStart, variableStart + nameLength);
      const extra = directory.slice(variableStart + nameLength, variableStart + nameLength + extraLength);
      const rawPath = decodeZipName(nameBytes, flags);
      const path = normalizeArchivePath(rawPath, this.label);
      const zip64 = readZip64Extra(extra, {
        compressedSize32,
        uncompressedSize32,
        localHeaderOffset32,
      });
      const compressedSize = zip64.compressedSize;
      const uncompressedSize = zip64.uncompressedSize;
      const localHeaderOffset = zip64.localHeaderOffset;
      const mode = (externalAttributes >>> 16) & 0o170000;
      const isSymlink = mode === 0o120000;
      const kind = rawPath.endsWith("/") || mode === 0o040000 ? "directory" : "file";

      entries.push({
        id: `${this.label}:${index}:${path}`,
        archiveLabel: this.label,
        index,
        path,
        rawPath,
        flags,
        compressionMethod,
        crc32: expectedCrc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        externalAttributes,
        kind,
        isSymlink,
      });

      cursor = variableEnd;
    }

    this.#entries = entries;
    return entries;
  }

  async readEntry(entry: ZipEntry, options: ReadEntryOptions): Promise<Uint8Array> {
    if ((entry.flags & 1) !== 0) {
      fail(`${entry.path}: encrypted ZIP entries are not supported`);
    }

    const dataOffset = await this.readDataOffset(entry);
    const compressed = await this.#source.read(dataOffset, entry.compressedSize);
    let data: Uint8Array;

    switch (entry.compressionMethod) {
      case 0:
        data = compressed;
        break;

      case 8:
        data = inflateRawSync(compressed);
        break;

      default:
        fail(`${entry.path}: unsupported ZIP compression method ${entry.compressionMethod}`);
    }

    if (data.byteLength !== entry.uncompressedSize) {
      fail(`${entry.path}: uncompressed size mismatch`);
    }

    if (options.checkCrc) {
      const actual = crc32(data);

      if (actual !== entry.crc32) {
        fail(`${entry.path}: CRC32 mismatch`);
      }
    }

    return data;
  }

  private async readCentralDirectoryInfo(): Promise<CentralDirectoryInfo> {
    const size = await this.#source.size();
    const tailLength = Math.min(size, 22 + 0xffff);
    const tailOffset = size - tailLength;
    const tail = await this.#source.read(tailOffset, tailLength);
    const view = viewOf(tail);

    for (let cursor = tail.byteLength - 22; cursor >= 0; cursor -= 1) {
      if (view.getUint32(cursor, true) !== eocdSignature) {
        continue;
      }

      const commentLength = view.getUint16(cursor + 20, true);

      if (cursor + 22 + commentLength !== tail.byteLength) {
        continue;
      }

      const diskNumber = view.getUint16(cursor + 4, true);
      const centralDirectoryDisk = view.getUint16(cursor + 6, true);
      const entriesOnDisk = view.getUint16(cursor + 8, true);
      const entries = view.getUint16(cursor + 10, true);
      const directorySize = view.getUint32(cursor + 12, true);
      const directoryOffset = view.getUint32(cursor + 16, true);

      if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entries) {
        fail(`${this.label}: multi-disk ZIP archives are not supported`);
      }

      if (
        entries === maxUint16 ||
        directorySize === maxUint32 ||
        directoryOffset === maxUint32
      ) {
        return this.readZip64CentralDirectoryInfo(tailOffset + cursor);
      }

      return {
        offset: directoryOffset,
        size: directorySize,
        entries,
      };
    }

    fail(`${this.label}: could not find ZIP end of central directory`);
  }

  private async readZip64CentralDirectoryInfo(eocdOffset: number): Promise<CentralDirectoryInfo> {
    const locatorOffset = eocdOffset - 20;

    if (locatorOffset < 0) {
      fail(`${this.label}: missing ZIP64 locator`);
    }

    const locator = await this.#source.read(locatorOffset, 20);
    const locatorView = viewOf(locator);

    if (locatorView.getUint32(0, true) !== zip64LocatorSignature) {
      fail(`${this.label}: missing ZIP64 locator`);
    }

    const zip64EocdOffset = readUint64(locatorView, 8, this.label);
    const record = await this.#source.read(zip64EocdOffset, 56);
    const view = viewOf(record);

    if (view.getUint32(0, true) !== zip64EocdSignature) {
      fail(`${this.label}: invalid ZIP64 end of central directory`);
    }

    const diskNumber = view.getUint32(16, true);
    const centralDirectoryDisk = view.getUint32(20, true);

    if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
      fail(`${this.label}: multi-disk ZIP archives are not supported`);
    }

    return {
      entries: readUint64(view, 32, this.label),
      size: readUint64(view, 40, this.label),
      offset: readUint64(view, 48, this.label),
    };
  }

  private async readDataOffset(entry: ZipEntry): Promise<number> {
    const header = await this.#source.read(entry.localHeaderOffset, 30);
    const view = viewOf(header);

    if (view.getUint32(0, true) !== localFileSignature) {
      fail(`${entry.path}: invalid local file header`);
    }

    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    return entry.localHeaderOffset + 30 + nameLength + extraLength;
  }
}

function readZip64Extra(
  extra: Uint8Array,
  sizes: {
    compressedSize32: number;
    uncompressedSize32: number;
    localHeaderOffset32: number;
  },
): {
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
} {
  let compressedSize = sizes.compressedSize32;
  let uncompressedSize = sizes.uncompressedSize32;
  let localHeaderOffset = sizes.localHeaderOffset32;
  let cursor = 0;

  while (cursor + 4 <= extra.byteLength) {
    const view = viewOf(extra);
    const tag = view.getUint16(cursor, true);
    const length = view.getUint16(cursor + 2, true);
    const dataStart = cursor + 4;
    const dataEnd = dataStart + length;

    if (dataEnd > extra.byteLength) {
      break;
    }

    if (tag === 0x0001) {
      const zip64View = viewOf(extra.slice(dataStart, dataEnd));
      let field = 0;

      if (uncompressedSize === maxUint32) {
        uncompressedSize = readUint64(zip64View, field, "ZIP64 extra field");
        field += 8;
      }

      if (compressedSize === maxUint32) {
        compressedSize = readUint64(zip64View, field, "ZIP64 extra field");
        field += 8;
      }

      if (localHeaderOffset === maxUint32) {
        localHeaderOffset = readUint64(zip64View, field, "ZIP64 extra field");
      }
    }

    cursor = dataEnd;
  }

  if (
    compressedSize === maxUint32 ||
    uncompressedSize === maxUint32 ||
    localHeaderOffset === maxUint32
  ) {
    fail(`ZIP64 extra field is missing required values`);
  }

  return {
    compressedSize,
    uncompressedSize,
    localHeaderOffset,
  };
}

function readUint64(view: DataView, offset: number, label: string): number {
  if (offset + 8 > view.byteLength) {
    fail(`${label}: truncated uint64`);
  }

  const value = view.getBigUint64(offset, true);

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${label}: value exceeds safe integer range`);
  }

  return Number(value);
}

function decodeZipName(bytes: Uint8Array, flags: number): string {
  if ((flags & 0x0800) !== 0) {
    return new TextDecoder().decode(bytes);
  }

  let value = "";

  for (const byte of bytes) {
    value += byte < 0x80 ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, "0")}`;
  }

  return value;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
