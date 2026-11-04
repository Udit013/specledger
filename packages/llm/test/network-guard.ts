import net from 'node:net';

// Loaded before every llm test file (vitest.config.ts). Any attempt to open a socket, which is
// what fetch, http, https and the AI SDK all do underneath, throws instead of connecting, so a
// test that reaches for the network fails rather than calling a real service.
export class NetworkBlockedError extends Error {
  constructor() {
    super('network access is disabled in the llm test suite');
    this.name = 'NetworkBlockedError';
  }
}

export const networkGuard = { attempts: 0, active: true };

net.Socket.prototype.connect = function blockedConnect(): never {
  networkGuard.attempts += 1;
  throw new NetworkBlockedError();
};
