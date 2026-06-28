export function crc32(data: Uint8Array): number {
  return Bun.hash.crc32(data) >>> 0;
}

export class Crc32 {
  #crc = 0;

  update(data: Uint8Array): this {
    this.#crc = Bun.hash.crc32(data, this.#crc) >>> 0;
    return this;
  }

  digest(): number {
    return this.#crc >>> 0;
  }
}
