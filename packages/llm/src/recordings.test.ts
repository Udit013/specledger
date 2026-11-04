import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { err } from '@specledger/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { networkGuard } from '../test/network-guard.js';
import { fakeProvider, okResult, pumpRequest, response } from '../test/support/fakes.js';
import { llmError } from './errors.js';
import {
  createRecordingProvider,
  createReplayProvider,
  HOW_TO_RECORD,
  recordingPath,
  serializeRecording,
} from './recordings.js';
import { replayKey } from './replay-key.js';

const OPTIONS = { timeoutMs: 1_000 };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llm-recordings-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ReplayProvider', () => {
  it('returns the recorded response for a matching request', async () => {
    const request = pumpRequest();
    const key = replayKey(request, 'gemini-x');
    const recorded = response('gemini-x');
    writeFileSync(
      recordingPath(dir, key),
      serializeRecording({
        schemaVersion: 1,
        key,
        origin: 'handcrafted',
        modelId: 'gemini-x',
        request,
        response: recorded,
      }),
    );
    expect(
      await createReplayProvider({ dir, modelId: 'gemini-x' }).extract(request, OPTIONS),
    ).toEqual({
      ok: true,
      value: recorded,
    });
  });

  it('reports a miss with the key and how to record it', async () => {
    const request = pumpRequest();
    const result = await createReplayProvider({ dir, modelId: 'gemini-x' }).extract(
      request,
      OPTIONS,
    );
    const key = replayKey(request, 'gemini-x');
    expect(result).toEqual({
      ok: false,
      error: llmError('REPLAY_MISS', `No recording for this request (key ${key}).`, {
        key,
        howToRecord: HOW_TO_RECORD,
      }),
    });
  });

  it('misses when the same request is replayed for another model', async () => {
    const request = pumpRequest();
    const key = replayKey(request, 'gemini-x');
    writeFileSync(
      recordingPath(dir, key),
      serializeRecording({
        schemaVersion: 1,
        key,
        origin: 'handcrafted',
        modelId: 'gemini-x',
        request,
        response: response('gemini-x'),
      }),
    );
    expect(
      await createReplayProvider({ dir, modelId: 'gemini-y' }).extract(request, OPTIONS),
    ).toMatchObject({
      ok: false,
      error: { code: 'REPLAY_MISS' },
    });
  });

  it('refuses a recording that is malformed or filed under the wrong key', async () => {
    const request = pumpRequest();
    const key = replayKey(request, 'gemini-x');
    const replay = createReplayProvider({ dir, modelId: 'gemini-x' });
    writeFileSync(recordingPath(dir, key), '{ not json');
    expect(await replay.extract(request, OPTIONS)).toMatchObject({
      ok: false,
      error: { code: 'SCHEMA_INVALID' },
    });
    writeFileSync(
      recordingPath(dir, key),
      serializeRecording({
        schemaVersion: 1,
        key: 'f'.repeat(64),
        origin: 'handcrafted',
        modelId: 'gemini-x',
        request,
        response: response('gemini-x'),
      }),
    );
    expect(await replay.extract(request, OPTIONS)).toMatchObject({
      ok: false,
      error: { code: 'SCHEMA_INVALID' },
    });
  });
});

describe('RecordingProvider', () => {
  it.each<[string, Record<string, string>, boolean]>([
    ['RECORD is unset', {}, true],
    ['RECORD is not exactly 1', { RECORD: 'true' }, true],
    ['the request is not flagged synthetic', { RECORD: '1' }, false],
  ])('refuses, without calling the real provider, when %s', async (_case, env, synthetic) => {
    const inner = fakeProvider('gemini', [okResult('gemini-model')]);
    const recorder = createRecordingProvider({ inner, dir, env });
    expect(await recorder.extract(pumpRequest({ synthetic }), OPTIONS)).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(inner.calls).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('records a synthetic request with RECORD=1, and Replay then answers it identically', async () => {
    const inner = fakeProvider('gemini', [okResult('gemini-model')]);
    const recorder = createRecordingProvider({ inner, dir, env: { RECORD: '1' } });
    const request = pumpRequest();
    const live = await recorder.extract(request, OPTIONS);
    expect(live.ok).toBe(true);
    const key = replayKey(request, 'gemini-model');
    expect(readdirSync(dir)).toEqual([`${key}.json`]);
    const replayed = await createReplayProvider({ dir, modelId: 'gemini-model' }).extract(
      request,
      OPTIONS,
    );
    expect(replayed).toEqual(live);
    const bytes = readFileSync(recordingPath(dir, key), 'utf8');
    await recorder.extract(request, OPTIONS);
    expect(readFileSync(recordingPath(dir, key), 'utf8')).toBe(bytes);
  });

  it('records nothing when the real call fails', async () => {
    const inner = fakeProvider('gemini', [err(llmError('RATE_LIMITED', 'quota'))]);
    const recorder = createRecordingProvider({ inner, dir, env: { RECORD: '1' } });
    expect(await recorder.extract(pumpRequest(), OPTIONS)).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never opened a socket', () => {
    expect(networkGuard.attempts).toBe(0);
  });
});
