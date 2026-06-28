import { Readable } from "node:stream";
import { createInflateRaw, inflateRawSync } from "node:zlib";
import { Crc32 } from "./crc32.ts";
import { fail } from "./errors.ts";
import { BufferRangeSource, SubRangeSource, type RangeSource } from "./range-source.ts";
import { normalizeArchivePath } from "./path-utils.ts";
import {
  decryptCompressedChunks,
  decryptCompressedData,
  entryHasCrc32,
  readAesExtra,
  type ZipAesExtra,
  type ZipEncryptionMethod,
} from "./zip-encryption.ts";

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
  readonly versionNeeded: number;
  readonly lastModTime: number;
  readonly compressionMethod: number;
  readonly rawCompressionMethod: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly centralNameLength: number;
  readonly centralExtraLength: number;
  readonly externalAttributes: number;
  readonly kind: "file" | "directory";
  readonly isSymlink: boolean;
  readonly encrypted: boolean;
  readonly encryptionMethod: ZipEncryptionMethod;
  readonly aesExtra: ZipAesExtra | undefined;
}

export interface ReadEntryOptions {
  checkCrc: boolean;
  password?: string | undefined;
}

export interface StreamEntryOptions extends ReadEntryOptions {
  chunkSize?: number;
}

export interface ZipEntryDataRange {
  offset: number;
  length: number;
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
  #dataOffsets: number[] = [];

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

      const versionNeeded = view.getUint16(cursor + 6, true);
      const flags = view.getUint16(cursor + 8, true);
      const rawCompressionMethod = view.getUint16(cursor + 10, true);
      const lastModTime = view.getUint16(cursor + 12, true);
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
      const aesExtra = readAesExtra(extra);
      const encrypted = (flags & 1) !== 0;
      const encryptionMethod = readEncryptionMethod(path, flags, rawCompressionMethod, aesExtra);
      const compressionMethod =
        encryptionMethod === "aes" ? aesExtra!.compressionMethod : rawCompressionMethod;
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
        versionNeeded,
        lastModTime,
        compressionMethod,
        rawCompressionMethod,
        crc32: expectedCrc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        centralNameLength: nameLength,
        centralExtraLength: extraLength,
        externalAttributes,
        kind,
        isSymlink,
        encrypted,
        encryptionMethod,
        aesExtra,
      });

      cursor = variableEnd;
    }

    this.#entries = entries;
    return entries;
  }

  async readEntry(entry: ZipEntry, options: ReadEntryOptions): Promise<Uint8Array> {
    const { offset } = await this.entryDataRange(entry);
    const compressed = decryptCompressedData(
      entry,
      await this.#source.read(offset, entry.compressedSize),
      options.password,
    );
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

    if (options.checkCrc && entryHasCrc32(entry)) {
      const actual = new Crc32().update(data).digest();

      if (actual !== entry.crc32) {
        fail(`${entry.path}: CRC32 mismatch`);
      }
    }

    return data;
  }

  async *streamEntry(entry: ZipEntry, options: StreamEntryOptions): AsyncGenerator<Uint8Array> {
    const { offset: dataOffset } = await this.entryDataRange(entry);
    const chunkSize = options.chunkSize ?? 1024 * 1024;
    const compressedChunks = decryptCompressedChunks(
      entry,
      this.readStoredChunks(dataOffset, entry.compressedSize, chunkSize),
      options.password,
    );
    const crc = new Crc32();
    let uncompressedBytes = 0;

    switch (entry.compressionMethod) {
      case 0: {
        for await (const chunk of compressedChunks) {
          uncompressedBytes += chunk.byteLength;

          if (options.checkCrc && entryHasCrc32(entry)) {
            crc.update(chunk);
          }

          yield chunk;
        }

        break;
      }

      case 8: {
        const stream = Readable.from(compressedChunks).pipe(createInflateRaw());

        for await (const output of stream) {
          const chunk = asUint8Array(output);
          uncompressedBytes += chunk.byteLength;

          if (uncompressedBytes > entry.uncompressedSize) {
            fail(`${entry.path}: uncompressed size mismatch`);
          }

          if (options.checkCrc && entryHasCrc32(entry)) {
            crc.update(chunk);
          }

          yield chunk;
        }

        break;
      }

      default:
        fail(`${entry.path}: unsupported ZIP compression method ${entry.compressionMethod}`);
    }

    if (uncompressedBytes !== entry.uncompressedSize) {
      fail(`${entry.path}: uncompressed size mismatch`);
    }

    if (options.checkCrc && entryHasCrc32(entry)) {
      const actual = crc.digest();

      if (actual !== entry.crc32) {
        fail(`${entry.path}: CRC32 mismatch`);
      }
    }
  }

  async entryDataRange(entry: ZipEntry): Promise<ZipEntryDataRange> {
    return {
      offset: await this.readDataOffset(entry),
      length: entry.compressedSize,
    };
  }

  entryPlannedRange(entry: ZipEntry): ZipEntryDataRange {
    // Used only for read-ahead planning; extraction still parses the local header.
    return {
      offset: entry.localHeaderOffset,
      length: 30 + entry.centralNameLength + entry.centralExtraLength + entry.compressedSize,
    };
  }

  async primeRange(offset: number, length: number): Promise<void> {
    await this.#source.prime?.(offset, length);
  }

  async openStoredEntryAsArchive(entry: ZipEntry, label: string): Promise<ZipArchive> {
    if (entry.encrypted) {
      fail(`${entry.path}: encrypted nested ZIP entries are not supported`);
    }

    if (entry.compressionMethod !== 0) {
      fail(`${entry.path}: --as-dir requires ZIP compression method 0 (stored)`);
    }

    const { offset } = await this.entryDataRange(entry);
    return new ZipArchive(new SubRangeSource(this.#source, offset, entry.compressedSize, label), label);
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
    const cached = this.#dataOffsets[entry.index];

    if (cached !== undefined) {
      return cached;
    }

    const header = await this.#source.read(entry.localHeaderOffset, 30);
    const view = viewOf(header);

    if (view.getUint32(0, true) !== localFileSignature) {
      fail(`${entry.path}: invalid local file header`);
    }

    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const offset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    this.#dataOffsets[entry.index] = offset;
    return offset;
  }

  private async *readStoredChunks(
    offset: number,
    size: number,
    chunkSize: number,
  ): AsyncGenerator<Uint8Array> {
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      fail(`${this.label}: invalid ZIP stream chunk size`);
    }

    let position = 0;

    while (position < size) {
      const length = Math.min(chunkSize, size - position);
      yield await this.#source.read(offset + position, length);
      position += length;
    }
  }
}

function asUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  fail(`zlib stream produced an unsupported chunk`);
}

function readEncryptionMethod(
  path: string,
  flags: number,
  rawCompressionMethod: number,
  aesExtra: ZipAesExtra | undefined,
): ZipEncryptionMethod {
  const encrypted = (flags & 1) !== 0;

  if (!encrypted) {
    if (rawCompressionMethod === 99) {
      fail(`${path}: AES ZIP entry is missing the encryption flag`);
    }

    return "none";
  }

  if (rawCompressionMethod === 99) {
    if (aesExtra === undefined) {
      fail(`${path}: AES ZIP entry is missing the 0x9901 extra field`);
    }

    return "aes";
  }

  if ((flags & 0x0040) !== 0) {
    fail(`${path}: PKWARE strong encryption is not supported`);
  }

  return "zipcrypto";
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
