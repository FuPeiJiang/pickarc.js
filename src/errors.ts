export class PickarcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PickarcError";
  }
}

export function fail(message: string): never {
  throw new PickarcError(message);
}
