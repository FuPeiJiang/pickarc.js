import { createCipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { fail } from "./errors.ts";

export type ZipEncryptionMethod = "none" | "zipcrypto" | "aes";

export interface ZipAesExtra {
  vendorVersion: number;
  strength: 1 | 2 | 3;
  compressionMethod: number;
}

export interface ZipEncryptionEntry {
  path: string;
  flags: number;
  versionNeeded: number;
  crc32: number;
  compressedSize: number;
  lastModTime: number;
  encryptionMethod: ZipEncryptionMethod;
  aesExtra: ZipAesExtra | undefined;
}

export function readAesExtra(extra: Uint8Array): ZipAesExtra | undefined {
  const view = viewOf(extra);
  let cursor = 0;

  while (cursor + 4 <= extra.byteLength) {
    const tag = view.getUint16(cursor, true);
    const length = view.getUint16(cursor + 2, true);
    const dataStart = cursor + 4;
    const dataEnd = dataStart + length;

    if (dataEnd > extra.byteLength) {
      break;
    }

    if (tag === 0x9901) {
      if (length < 7) {
        fail(`AES ZIP extra field is truncated`);
      }

      const vendorVersion = view.getUint16(dataStart, true);

      if (vendorVersion !== 1 && vendorVersion !== 2) {
        fail(`AES ZIP extra field has unsupported version ${vendorVersion}`);
      }

      if (extra[dataStart + 2] !== 0x41 || extra[dataStart + 3] !== 0x45) {
        fail(`AES ZIP extra field has unsupported vendor ID`);
      }

      const strength = extra[dataStart + 4];

      if (strength !== 1 && strength !== 2 && strength !== 3) {
        fail(`AES ZIP extra field has unsupported strength ${strength}`);
      }

      return {
        vendorVersion,
        strength,
        compressionMethod: view.getUint16(dataStart + 5, true),
      };
    }

    cursor = dataEnd;
  }

  return undefined;
}

export function entryHasCrc32(entry: ZipEncryptionEntry): boolean {
  return entry.encryptionMethod !== "aes" || entry.aesExtra?.vendorVersion === 1;
}

export function decryptCompressedData(
  entry: ZipEncryptionEntry,
  encrypted: Uint8Array,
  password: string | undefined,
): Uint8Array {
  switch (entry.encryptionMethod) {
    case "none":
      return encrypted;

    case "zipcrypto":
      return decryptZipCryptoData(entry, encrypted, requirePassword(entry, password));

    case "aes":
      return decryptAesData(entry, encrypted, requirePassword(entry, password));
  }
}

export async function* decryptCompressedChunks(
  entry: ZipEncryptionEntry,
  chunks: AsyncIterable<Uint8Array>,
  password: string | undefined,
): AsyncGenerator<Uint8Array> {
  switch (entry.encryptionMethod) {
    case "none":
      yield* chunks;
      return;

    case "zipcrypto":
      yield* decryptZipCryptoChunks(entry, chunks, requirePassword(entry, password));
      return;

    case "aes":
      yield* decryptAesChunks(entry, chunks, requirePassword(entry, password));
      return;
  }
}

function requirePassword(entry: ZipEncryptionEntry, password: string | undefined): string {
  if (password === undefined) {
    fail(`${entry.path}: encrypted ZIP entry requires a password`);
  }

  return password;
}

function decryptZipCryptoData(
  entry: ZipEncryptionEntry,
  encrypted: Uint8Array,
  password: string,
): Uint8Array {
  if (encrypted.byteLength < 12) {
    fail(`${entry.path}: truncated ZipCrypto header`);
  }

  const decrypter = new ZipCryptoDecrypter(password);
  const header = decrypter.decrypt(encrypted.subarray(0, 12));
  validateZipCryptoHeader(entry, header);
  return decrypter.decrypt(encrypted.subarray(12));
}

async function* decryptZipCryptoChunks(
  entry: ZipEncryptionEntry,
  chunks: AsyncIterable<Uint8Array>,
  password: string,
): AsyncGenerator<Uint8Array> {
  const decrypter = new ZipCryptoDecrypter(password);
  let header: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let headerDone = false;

  for await (const chunk of chunks) {
    let cursor = 0;

    if (!headerDone) {
      const needed = 12 - header.byteLength;
      const take = Math.min(needed, chunk.byteLength);
      header = concatBytes([header, chunk.subarray(0, take)]);
      cursor = take;

      if (header.byteLength < 12) {
        continue;
      }

      validateZipCryptoHeader(entry, decrypter.decrypt(header));
      headerDone = true;
    }

    if (cursor < chunk.byteLength) {
      yield decrypter.decrypt(chunk.subarray(cursor));
    }
  }

  if (!headerDone) {
    fail(`${entry.path}: truncated ZipCrypto header`);
  }
}

class ZipCryptoDecrypter {
  #key0 = 0x12345678;
  #key1 = 0x23456789;
  #key2 = 0x34567890;

  constructor(password: string) {
    const bytes = new TextEncoder().encode(password);

    for (let index = 0; index < bytes.byteLength; index += 1) {
      this.updateKeys(bytes[index]!);
    }
  }

  decrypt(input: Uint8Array): Uint8Array {
    const output = new Uint8Array(input.byteLength);

    for (let index = 0; index < input.byteLength; index += 1) {
      const value = input[index]! ^ this.decryptByte();
      this.updateKeys(value);
      output[index] = value;
    }

    return output;
  }

  private updateKeys(byte: number): void {
    this.#key0 = crc32RawByte(this.#key0, byte);
    this.#key1 = (Math.imul((this.#key1 + (this.#key0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    this.#key2 = crc32RawByte(this.#key2, this.#key1 >>> 24);
  }

  private decryptByte(): number {
    const temp = (this.#key2 | 2) & 0xffff;
    return (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
  }
}

function validateZipCryptoHeader(entry: ZipEncryptionEntry, header: Uint8Array): void {
  const expected = zipCryptoCheckByte(entry);

  if (header[11] !== expected) {
    fail(`${entry.path}: wrong password or unsupported ZipCrypto header`);
  }
}

function zipCryptoCheckByte(entry: ZipEncryptionEntry): number {
  if ((entry.flags & 0x0008) !== 0) {
    return (entry.lastModTime >>> 8) & 0xff;
  }

  return (entry.crc32 >>> 24) & 0xff;
}

function decryptAesData(
  entry: ZipEncryptionEntry,
  encrypted: Uint8Array,
  password: string,
): Uint8Array {
  const params = aesParams(entry);
  const headerLength = params.saltLength + 2;
  const authLength = 10;

  if (encrypted.byteLength < headerLength + authLength) {
    fail(`${entry.path}: truncated AES ZIP data`);
  }

  const decrypter = createAesDecrypter(
    entry,
    password,
    encrypted.subarray(0, params.saltLength),
    encrypted.subarray(params.saltLength, headerLength),
  );
  const ciphertext = encrypted.subarray(headerLength, encrypted.byteLength - authLength);
  const authCode = encrypted.subarray(encrypted.byteLength - authLength);
  decrypter.verify(ciphertext, authCode);
  return decrypter.decrypt(ciphertext);
}

async function* decryptAesChunks(
  entry: ZipEncryptionEntry,
  chunks: AsyncIterable<Uint8Array>,
  password: string,
): AsyncGenerator<Uint8Array> {
  const params = aesParams(entry);
  const headerLength = params.saltLength + 2;
  let header: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let tail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let decrypter: AesDecrypter | undefined;

  for await (const chunk of chunks) {
    let cursor = 0;

    if (decrypter === undefined) {
      const needed = headerLength - header.byteLength;
      const take = Math.min(needed, chunk.byteLength);
      header = concatBytes([header, chunk.subarray(0, take)]);
      cursor = take;

      if (header.byteLength < headerLength) {
        continue;
      }

      decrypter = createAesDecrypter(
        entry,
        password,
        header.subarray(0, params.saltLength),
        header.subarray(params.saltLength),
      );
    }

    if (cursor >= chunk.byteLength) {
      continue;
    }

    const combined = concatBytes([tail, chunk.subarray(cursor)]);

    if (combined.byteLength <= 10) {
      tail = combined;
      continue;
    }

    const ciphertext = combined.subarray(0, combined.byteLength - 10);
    tail = combined.subarray(combined.byteLength - 10);
    decrypter.updateMac(ciphertext);
    yield decrypter.decrypt(ciphertext);
  }

  if (decrypter === undefined) {
    fail(`${entry.path}: truncated AES ZIP data`);
  }

  if (tail.byteLength !== 10) {
    fail(`${entry.path}: truncated AES ZIP authentication code`);
  }

  decrypter.verifyMac(tail);
}

interface AesParams {
  bits: 128 | 192 | 256;
  keyLength: number;
  saltLength: number;
}

interface AesDecrypter {
  decrypt(data: Uint8Array): Uint8Array;
  updateMac(data: Uint8Array): void;
  verify(data: Uint8Array, authCode: Uint8Array): void;
  verifyMac(authCode: Uint8Array): void;
}

function createAesDecrypter(
  entry: ZipEncryptionEntry,
  password: string,
  salt: Uint8Array,
  passwordVerifier: Uint8Array,
): AesDecrypter {
  const params = aesParams(entry);
  const material = pbkdf2Sync(
    Buffer.from(password, "utf8"),
    Buffer.from(salt),
    1000,
    params.keyLength * 2 + 2,
    "sha1",
  );
  const expectedVerifier = material.subarray(params.keyLength * 2);

  if (!constantTimeEqual(expectedVerifier, passwordVerifier)) {
    fail(`${entry.path}: wrong AES ZIP password`);
  }

  const cipher = new AesCtrDecrypter(params.bits, material.subarray(0, params.keyLength));
  const mac = createHmac("sha1", material.subarray(params.keyLength, params.keyLength * 2));

  return {
    decrypt(data) {
      return cipher.decrypt(data);
    },
    updateMac(data) {
      mac.update(data);
    },
    verify(data, authCode) {
      mac.update(data);
      verifyMac(entry, mac.digest().subarray(0, 10), authCode);
    },
    verifyMac(authCode) {
      verifyMac(entry, mac.digest().subarray(0, 10), authCode);
    },
  };
}

class AesCtrDecrypter {
  readonly #algorithm: "aes-128-ecb" | "aes-192-ecb" | "aes-256-ecb";
  readonly #key: Buffer;
  #counter = 1n;
  #keystream: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  constructor(bits: 128 | 192 | 256, key: Uint8Array) {
    this.#algorithm = `aes-${bits}-ecb`;
    this.#key = Buffer.from(key);
  }

  decrypt(data: Uint8Array): Uint8Array {
    const output = new Uint8Array(data.byteLength);
    let cursor = 0;

    if (this.#keystream.byteLength > 0) {
      const take = Math.min(this.#keystream.byteLength, data.byteLength);
      xorInto(output, 0, data, 0, this.#keystream, 0, take);
      this.#keystream = this.#keystream.subarray(take);
      cursor = take;
    }

    if (cursor >= data.byteLength) {
      return output;
    }

    const remaining = data.byteLength - cursor;
    const blockCount = Math.ceil(remaining / 16);
    const counterBlocks = new Uint8Array(blockCount * 16);

    for (let block = 0; block < blockCount; block += 1) {
      writeLittleEndianCounter(counterBlocks, block * 16, this.#counter);
      this.#counter += 1n;
    }

    const cipher = createCipheriv(this.#algorithm, this.#key, null);
    cipher.setAutoPadding(false);
    const keystream = concatBuffers([cipher.update(counterBlocks), cipher.final()]);
    xorInto(output, cursor, data, cursor, keystream, 0, remaining);

    if (keystream.byteLength > remaining) {
      this.#keystream = keystream.subarray(remaining);
    }

    return output;
  }
}

function aesParams(entry: ZipEncryptionEntry): AesParams {
  const strength = entry.aesExtra?.strength;

  switch (strength) {
    case 1:
      return {
        bits: 128,
        keyLength: 16,
        saltLength: 8,
      };

    case 2:
      return {
        bits: 192,
        keyLength: 24,
        saltLength: 12,
      };

    case 3:
      return {
        bits: 256,
        keyLength: 32,
        saltLength: 16,
      };

    default:
      fail(`${entry.path}: missing AES ZIP metadata`);
  }
}

function verifyMac(entry: ZipEncryptionEntry, actual: Uint8Array, expected: Uint8Array): void {
  if (!constantTimeEqual(actual, expected)) {
    fail(`${entry.path}: AES ZIP authentication failed`);
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function writeLittleEndianCounter(output: Uint8Array, offset: number, counter: bigint): void {
  let value = counter;

  for (let index = 0; index < 16; index += 1) {
    output[offset + index] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function xorInto(
  output: Uint8Array,
  outputOffset: number,
  input: Uint8Array,
  inputOffset: number,
  key: Uint8Array,
  keyOffset: number,
  length: number,
): void {
  for (let index = 0; index < length; index += 1) {
    output[outputOffset + index] = input[inputOffset + index]! ^ key[keyOffset + index]!;
  }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    total += chunks[index]!.byteLength;
  }

  const output = new Uint8Array(total);
  let offset = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function concatBuffers(chunks: readonly Buffer[]): Uint8Array {
  return Buffer.concat(chunks);
}

const crcTable = new Uint32Array(256);

for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;

  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  crcTable[index] = value >>> 0;
}

function crc32RawByte(crc: number, byte: number): number {
  return (crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
