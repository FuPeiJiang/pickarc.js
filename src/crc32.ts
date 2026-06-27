const table = new Uint32Array(256);

for (let i = 0; i < table.length; i += 1) {
  let value = i;

  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  table[i] = value >>> 0;
}

export function crc32(data: Uint8Array): number {
  return new Crc32().update(data).digest();
}

export class Crc32 {
  #crc = 0xffffffff;

  update(data: Uint8Array): this {
    for (const byte of data) {
      this.#crc = table[(this.#crc ^ byte) & 0xff]! ^ (this.#crc >>> 8);
    }

    return this;
  }

  digest(): number {
    return (this.#crc ^ 0xffffffff) >>> 0;
  }
}
