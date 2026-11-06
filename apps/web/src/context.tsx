import type { UserRole } from '@specledger/core';
import { createContext, useContext } from 'react';

import type { ApiClient } from './api/client.js';
import type { PollOptions } from './lib/backoff.js';

// Where the screens are working:
//   showcase  the public, read-only demo data; nobody is signed in
//   demo      the visitor's private demo sandbox, acting as every role but admin
//   account   the real workspace, as the signed-in user with their roles
export type Mode = 'showcase' | 'demo' | 'account';

export interface AppServices {
  readonly client: ApiClient;
  readonly poll: PollOptions;
  readonly mode: Mode;
  // Whether the current person holds the role. The server decides; this only hides what would be
  // refused anyway.
  readonly can: (role: UserRole) => boolean;
  // Says something to screen-reader users through the polite live region.
  readonly announce: (message: string) => void;
}

export const ServicesContext = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (services === null) throw new Error('useServices is used outside ServicesContext');
  return services;
}
