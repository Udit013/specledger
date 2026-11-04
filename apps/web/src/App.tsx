import type { QueryClient } from '@tanstack/react-query';

import type { PollOptions } from './lib/backoff.js';
import { notImplemented } from './lib/not-implemented.js';

export interface AppProps {
  readonly baseUrl: string;
  readonly storage: Storage;
  readonly queryClient: QueryClient;
  readonly poll?: PollOptions;
}
export function App(props: AppProps): never {
  return notImplemented(`App(${props.baseUrl})`);
}
