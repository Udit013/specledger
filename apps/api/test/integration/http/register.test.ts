import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  bearer,
  processQueued,
  truthProvider,
  upload,
  withApp,
  ACTORS,
} from '../../support/http.js';

// Each test runs on a database of its own, because publish reads the whole register.
const IDS = [
  'p-106-datasheet',
  'p-106-brochure',
  'p-110-datasheet',
  'p-113-datasheet',
  'm-201-datasheet-rev-a',
  'm-201-datasheet-rev-b',
];
const provider = truthProvider(IDS);

interface Field {
  id: string;
  name: string;
  verificationStatus: string;
  version: number;
}
interface Conflict {
  id: string;
  fieldName: string;
  status: string;
  candidates: {
    fieldId: string;
    documentId: string;
    documentType: string;
    value: string;
    unit: string;
    quote: string;
    page: number;
  }[];
  suggestion: { fieldId: string | null; rules: string[] };
}

function suite() {
  const ctx = withApp();
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    role: 'engineer' | 'reviewer' | 'approver',
    payload?: unknown,
  ) =>
    ctx.app.inject({
      method,
      url,
      headers: bearer(role),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  async function documentId(id: string, tag: string, fields: Record<string, string> = {}) {
    const response = await upload(ctx.app, id, tag, fields);
    return response.json<{ document: { id: string } }>().document.id;
  }

  async function reviewAll(documentIds: readonly string[]) {
    for (const id of documentIds) {
      const fields = (await call('GET', `/documents/${id}/fields`, 'engineer')).json<{
        fields: Field[];
      }>().fields;
      for (const field of fields) {
        const body =
          field.verificationStatus === 'verified'
            ? { action: 'accept', expectedVersion: field.version }
            : { action: 'reject', expectedVersion: field.version };
        expect((await call('PATCH', `/fields/${field.id}`, 'reviewer', body)).statusCode).toBe(200);
      }
    }
  }

  const conflicts = async (status = 'open') =>
    (await call('GET', `/conflicts?status=${status}`, 'engineer')).json<{ conflicts: Conflict[] }>()
      .conflicts;
  const versionCount = async () =>
    (await ctx.testDb.query('select count(*)::int as n from register_versions')).rows[0]?.n;

  return { ctx, call, documentId, reviewAll, conflicts, versionCount };
}

describe('POST /register/publish with blockers', () => {
  const s = suite();

  it('refuses with 409 PUBLISH_BLOCKED, listing every blocker, and creates nothing', async () => {
    const tag = 'P-106';
    const datasheet = await s.documentId('p-106-datasheet', tag);
    await s.documentId('p-106-brochure', tag, { documentType: 'datasheet' }); // equal rank: conflict on rated_head
    const queued = await s.documentId('m-201-datasheet-rev-a', 'M-201');
    // Process only the two P-106 documents; M-201 stays queued.
    await s.ctx.testDb.query(
      `update jobs set run_at = run_at + interval '1 day' where payload->>'documentId' = $1`,
      [queued],
    );
    await processQueued(s.ctx.testDb, provider);

    const response = await s.call('POST', '/register/publish', 'approver');
    expect(response.statusCode).toBe(409);
    const blockers = response.json<{
      error: { code: string; details: { blockers: { kind: string; fieldName: string | null }[] } };
    }>();
    expect(blockers.error.code).toBe('PUBLISH_BLOCKED');
    const kinds = new Set(blockers.error.details.blockers.map((b) => b.kind));
    expect([...kinds].sort()).toEqual(['CONFLICT_OPEN', 'FIELD_PENDING_REVIEW', 'JOB_IN_PROGRESS']);
    expect(
      blockers.error.details.blockers
        .filter((b) => b.kind === 'CONFLICT_OPEN')
        .map((b) => b.fieldName),
    ).toEqual(['rated_head']);
    expect(await s.versionCount()).toBe(0);
    expect(datasheet).toBeTruthy();
  });

  it('rejects an engineer with 403', async () => {
    expect((await s.call('POST', '/register/publish', 'engineer')).statusCode).toBe(403);
  });
});

describe('conflict resolution feeding reconciliation and publish', () => {
  const s = suite();

  it('resolves, publishes reconciled values, exports them, and re-reviews after a later revision', async () => {
    const tag = 'P-106';
    const ids = [
      await s.documentId('p-106-datasheet', tag),
      await s.documentId('p-106-brochure', tag, { documentType: 'datasheet' }),
    ];
    await processQueued(s.ctx.testDb, provider);

    const [conflict] = await s.conflicts();
    expect(conflict).toMatchObject({ fieldName: 'rated_head', status: 'open' });
    expect(conflict?.candidates.map((c) => `${c.value} ${c.unit}`).sort()).toEqual([
      '250 ft',
      '260 ft',
    ]);
    // Each candidate carries its evidence, and the rules alone cannot choose between equals.
    for (const candidate of conflict?.candidates ?? []) {
      expect(candidate.quote).toContain(candidate.value);
      expect(candidate.page).toBeGreaterThanOrEqual(1);
    }
    expect(conflict?.suggestion.fieldId).toBeNull();
    expect(conflict?.suggestion.rules).toContain('EQUAL_RANK_CONFLICT');

    // Validation, then the resolution itself.
    const noReason = await s.call('POST', `/conflicts/${conflict?.id ?? ''}/resolve`, 'reviewer', {
      choice: { kind: 'value', value: '255', unit: 'ft' },
    });
    expect(noReason.statusCode).toBe(400);
    const badValue = await s.call('POST', `/conflicts/${conflict?.id ?? ''}/resolve`, 'reviewer', {
      choice: { kind: 'value', value: '255', unit: 'kW' },
      reason: 'x',
    });
    expect(badValue.json()).toMatchObject({ error: { code: 'INVALID_VALUE' } });
    const implausible = await s.call(
      'POST',
      `/conflicts/${conflict?.id ?? ''}/resolve`,
      'reviewer',
      { choice: { kind: 'value', value: '255000', unit: 'ft' }, reason: 'x' },
    );
    expect(implausible.json()).toMatchObject({ error: { code: 'INVALID_VALUE' } });
    const stranger = await s.call('POST', `/conflicts/${conflict?.id ?? ''}/resolve`, 'reviewer', {
      choice: { kind: 'candidate', fieldId: randomUUID() },
      reason: 'x',
    });
    expect(stranger.json()).toMatchObject({ error: { code: 'CANDIDATE_NOT_IN_CONFLICT' } });
    const chosen = conflict?.candidates.find((c) => c.value === '260');
    const resolved = await s.call('POST', `/conflicts/${conflict?.id ?? ''}/resolve`, 'reviewer', {
      choice: { kind: 'candidate', fieldId: chosen?.fieldId },
      reason: 'the datasheet value, confirmed by the vendor',
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      status: 'resolved',
      resolution: {
        value: '260',
        unit: 'ft',
        resolvedBy: ACTORS.reviewer,
        chosenFieldId: chosen?.fieldId,
      },
    });
    const twice = await s.call('POST', `/conflicts/${conflict?.id ?? ''}/resolve`, 'reviewer', {
      choice: { kind: 'value', value: '255', unit: 'ft' },
      reason: 'x',
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ error: { code: 'CONFLICT_ALREADY_RESOLVED' } });
    const audit = await s.call('GET', `/audit?entity=conflict:${conflict?.id ?? ''}`, 'approver');
    expect(audit.json<{ events: { action: string }[] }>().events.map((e) => e.action)).toEqual([
      'extract',
      'resolve',
    ]);

    // New evidence from a lineage the decision was not based on (a brochure) leaves it standing:
    // reconciliation keeps the decision and opens no conflict.
    ids.push(
      await s.documentId('p-113-datasheet', tag, { documentType: 'brochure', revision: '' }),
    );
    await processQueued(s.ctx.testDb, provider);
    expect(await s.conflicts()).toEqual([]);

    await s.reviewAll(ids);
    const published = await s.call('POST', '/register/publish', 'approver');
    expect(published.statusCode).toBe(201);
    expect(published.json()).toMatchObject({
      version: { number: 1, approvedBy: ACTORS.approver },
      itemCount: 1,
    });

    const json = await s.call('GET', '/register/versions/1/export?format=json', 'engineer');
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toContain('application/json');
    const exported = JSON.parse(json.body) as {
      items: { tag: string; values: Record<string, { value: string; unit: string }> }[];
    };
    expect(exported.items).toHaveLength(1);
    expect(exported.items[0]?.values.rated_head).toEqual({ value: '260', unit: 'ft' });
    expect(exported.items[0]?.values.rated_flow).toEqual({ value: '1997', unit: 'gpm' });
    const csv = await s.call('GET', '/register/versions/1/export?format=csv', 'approver');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toBe('tag,field,value,unit');
    expect(csv.body).toContain('P-106,rated_head,260,ft');

    // A later revision in a lineage the decision was based on: the decision stands but the field
    // needs re-review, which reopens it as a conflict and blocks the next publish.
    const later = await s.documentId('p-110-datasheet', tag, { revision: 'Rev B' });
    await processQueued(s.ctx.testDb, provider);
    const reopened = await s.conflicts();
    expect(reopened.map((c) => c.fieldName)).toContain('rated_head');
    // Without the decision, the rules would take the later revision: that is the suggestion.
    const head = reopened.find((c) => c.fieldName === 'rated_head');
    const revB = head?.candidates.find((c) => c.documentId === later);
    expect(head?.suggestion).toMatchObject({ fieldId: revB?.fieldId });
    expect(head?.suggestion.rules).toContain('LATER_REVISION');
    const blocked = await s.call('POST', '/register/publish', 'approver');
    expect(blocked.statusCode).toBe(409);
    expect(later).toBeTruthy();
  });

  it('rejects bad export requests', async () => {
    expect(
      (await s.call('GET', '/register/versions/99/export?format=json', 'engineer')).statusCode,
    ).toBe(404);
    expect(
      (await s.call('GET', '/register/versions/1/export?format=xlsx', 'engineer')).statusCode,
    ).toBe(400);
    expect(
      (await s.call('GET', '/register/versions/0/export?format=csv', 'engineer')).statusCode,
    ).toBe(400);
  });

  it('returns 404 for an unknown conflict and 400 for a bad id', async () => {
    expect(
      (
        await s.call('POST', `/conflicts/${randomUUID()}/resolve`, 'reviewer', {
          choice: { kind: 'value', value: '1', unit: 'm' },
          reason: 'x',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await s.call('POST', '/conflicts/nope/resolve', 'reviewer', {
          choice: { kind: 'value', value: '1', unit: 'm' },
          reason: 'x',
        })
      ).statusCode,
    ).toBe(400);
    expect((await s.call('GET', '/conflicts?status=maybe', 'engineer')).statusCode).toBe(400);
  });
});

describe('parallel publishes', () => {
  const s = suite();

  it('take consecutive version numbers with no gap and no duplicate', async () => {
    const ids = [
      await s.documentId('m-201-datasheet-rev-a', 'M-201'),
      await s.documentId('m-201-datasheet-rev-b', 'M-201', { revision: 'Rev B' }),
    ];
    await processQueued(s.ctx.testDb, provider);
    await s.reviewAll(ids);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => s.call('POST', '/register/publish', 'approver')),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    const numbers = responses
      .map((r) => r.json<{ version: { number: number } }>().version.number)
      .sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    // Rev B supersedes Rev A in every version.
    const exported = JSON.parse(
      (await s.call('GET', '/register/versions/5/export?format=json', 'engineer')).body,
    ) as {
      items: { values: Record<string, { value: string }> }[];
    };
    expect(exported.items[0]?.values.rated_current).toEqual({ value: '76.3', unit: 'A' });
  });
});

describe('nothing to publish', () => {
  const s = suite();

  it('answers 409 NOTHING_TO_PUBLISH on an empty register', async () => {
    const response = await s.call('POST', '/register/publish', 'approver');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'NOTHING_TO_PUBLISH' } });
  });
});
