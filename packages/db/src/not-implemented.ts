// Thrown by the Phase 7 stubs until their bodies are written (test-first: the suite is written
// against these signatures before the implementation exists).
export class NotImplementedError extends Error {
  constructor(name: string) {
    super(`${name} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

export function notImplemented(name: string, ...args: readonly unknown[]): never {
  throw Object.assign(new NotImplementedError(name), { argumentCount: args.length });
}
