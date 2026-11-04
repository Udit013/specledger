import { createContext, useContext } from 'react';

import type { ApiClient } from './api/client.js';
import type { PollOptions } from './lib/backoff.js';

export interface AppServices {
  readonly client: ApiClient;
  readonly poll: PollOptions;
  // Says something to screen-reader users through the polite live region.
  readonly announce: (message: string) => void;
}

export const ServicesContext = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (services === null) throw new Error('useServices is used outside ServicesContext');
  return services;
}
