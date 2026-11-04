import { notImplemented } from './not-implemented.js';
export interface PollOptions {
  readonly baseMs?: number;
  readonly maxMs?: number;
}
export function pollDelay(unchangedPolls: number, options: PollOptions = {}): number {
  return notImplemented(`pollDelay(${String(unchangedPolls)}${JSON.stringify(options)})`);
}
