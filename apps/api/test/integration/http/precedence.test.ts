import { describe, expect, it } from 'vitest';

import { bearer, processQueued, truthProvider, upload, withApp } from '../../support/http.js';

// Rejecting the value of the document that takes precedence for a field (a later revision of the
// same document, or a higher-ranked source) must not let publishing fall back silently to the
// value it supersedes. "Reject" says the extraction is wrong, not that the document has no value:
// the newer revision may well state something else. The fallback has to be a human decision, so
// the rejection opens a conflict on the field, which blocks publishing until it is resolved.

const provider = truthProvider([
  'm-201-datasheet-rev-a',
  'm-201-datasheet-rev-b',
  'p-106-datasheet',
  'p-106-brochure',
]);

interface Field {
  id: string;
  name: string;
  value: string;
  unit: string;
  verificationStatus: string;
  version: number;
}
interface Conflict {
  id: string;
  fieldName: string;
  equipmentTag: string;
  candidates: { fieldId: string; documentId: string; value: string; unit: string }[];
}

function suite() {
  const ctx = withApp();
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    role: 'engineer' | 'approver',
    payload?: unknown,
  ) =>
    ctx.app.inject({
      method,
      url,
      headers: bearer(role),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const documentId = async (id: string, tag: string, fields: Record<string, string> = {}) =>
    (await upload(ctx.app, id, tag, fields)).json<{ document: { id: string } }>().document.id;
  const fieldsOf = async (id: string) =>
    (await call('GET', `/documents/${id}/fields`, 'engineer')).json<{ fields: Field[] }>().fields;
  // Accept every field of the documents, except those named in `reject` for one document.
  async function review(
    ids: readonly string[],
    reject: { document: string; fields: readonly string[] }[] = [],
  ) {
    for (const id of ids) {
      const rejected = reject.find((r) => r.document === id)?.fields ?? [];
      for (const field of await fieldsOf(id)) {
        const action = rejected.includes(field.name) ? 'reject' : 'accept';
        const body =
          action === 'accept' && field.verificationStatus !== 'verified'
            ? { action, expectedVersion: field.version, reason: 'checked' }
            : { action, expectedVersion: field.version };
        expect((await call('PATCH', `/fields/${field.id}`, 'engineer', body)).statusCode).toBe(200);
      }
    }
  }
  const openConflicts = async () =>
    (await call('GET', '/conflicts?status=open', 'engineer')).json<{ conflicts: Conflict[] }>()
      .conflicts;
  return { ctx, call, documentId, review, openConflicts };
}

describe('rejecting the later revision of a field', () => {
  const s = suite();

  it('opens a conflict instead of publishing the superseded value, and lets a human decide', async () => {
    const revA = await s.documentId('m-201-datasheet-rev-a', 'M-201');
    const revB = await s.documentId('m-201-datasheet-rev-b', 'M-201', { revision: 'Rev B' });
    await processQueued(s.ctx.testDb, provider);
    expect(await s.openConflicts()).toEqual([]);

    // Rev B says 76.3 A, Rev A said 78.6 A. The reviewer rejects Rev B's extraction.
    await s.review([revA, revB], [{ document: revB, fields: ['rated_current'] }]);

    const conflicts = await s.openConflicts();
    expect(conflicts.map((c) => [c.equipmentTag, c.fieldName])).toEqual([
      ['M-201', 'rated_current'],
    ]);
    const blocked = await s.call('POST', '/register/publish', 'approver');
    expect(blocked.statusCode).toBe(409);
    expect(
      blocked
        .json<{ error: { details: { blockers: { kind: string; fieldName: string | null }[] } } }>()
        .error.details.blockers.map((b) => [b.kind, b.fieldName]),
    ).toEqual([['CONFLICT_OPEN', 'rated_current']]);

    // The conflict's history says why it was opened, and by whom.
    const conflict = conflicts[0];
    if (conflict === undefined) throw new Error('no conflict');
    const audit = await s.call('GET', `/audit?entity=conflict:${conflict.id}`, 'approver');
    const events = audit.json<{ events: { action: string; actor: string; after: unknown }[] }>()
      .events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'reject',
      actor: 'role:engineer',
      after: { status: 'open', reason: 'PRECEDENCE_REJECTED' },
    });

    // A human decides that Rev A's value stands; then the register can be published with it.
    const revAField = conflict.candidates.find((c) => c.documentId === revA);
    const resolved = await s.call('POST', `/conflicts/${conflict.id}/resolve`, 'engineer', {
      choice: { kind: 'candidate', fieldId: revAField?.fieldId },
      reason: 'Rev B changed only the efficiency; the vendor confirmed 78.6 A',
    });
    expect(resolved.statusCode).toBe(200);
    const published = await s.call('POST', '/register/publish', 'approver');
    expect(published.statusCode).toBe(201);
    const exported = JSON.parse(
      (await s.call('GET', '/register/versions/1/export?format=json', 'engineer')).body,
    ) as { items: { values: Record<string, { value: string; unit: string }> }[] };
    expect(exported.items[0]?.values.rated_current).toEqual({ value: '78.6', unit: 'A' });

    // The decision now covers the field: rejecting Rev B's value again opens nothing new.
    const revBField = conflict.candidates.find((c) => c.documentId === revB);
    const current = (await s.call('GET', `/documents/${revB}/fields`, 'engineer'))
      .json<{ fields: Field[] }>()
      .fields.find((f) => f.id === revBField?.fieldId);
    const again = await s.call('PATCH', `/fields/${current?.id ?? ''}`, 'engineer', {
      action: 'reject',
      expectedVersion: current?.version,
    });
    expect(again.statusCode).toBe(200);
    expect(await s.openConflicts()).toEqual([]);
  });
});

describe('rejecting the higher-ranked source of a field', () => {
  const s = suite();

  it('opens a conflict when the datasheet is rejected, and none when the brochure is', async () => {
    const datasheet = await s.documentId('p-106-datasheet', 'P-106');
    const brochure = await s.documentId('p-106-brochure', 'P-106', {
      documentType: 'brochure',
      revision: '',
    });
    await processQueued(s.ctx.testDb, provider);
    await s.review(
      [datasheet, brochure],
      [
        { document: datasheet, fields: ['rated_head'] },
        { document: brochure, fields: ['rated_flow'] },
      ],
    );
    // The brochure's 250 ft would otherwise replace the datasheet's 260 ft without anyone deciding.
    // Rejecting the brochure's flow changes nothing: the datasheet outranks it anyway.
    expect((await s.openConflicts()).map((c) => c.fieldName)).toEqual(['rated_head']);
  });
});

describe('rejecting a value nothing else would replace', () => {
  const s = suite();

  it('opens no conflict and publishes without the rejected field, as before', async () => {
    const only = await s.documentId('p-106-datasheet', 'P-106');
    await processQueued(s.ctx.testDb, provider);
    await s.review([only], [{ document: only, fields: ['rated_head'] }]);
    expect(await s.openConflicts()).toEqual([]);
    const published = await s.call('POST', '/register/publish', 'approver');
    expect(published.statusCode).toBe(201);
    const exported = JSON.parse(
      (await s.call('GET', '/register/versions/1/export?format=json', 'engineer')).body,
    ) as { items: { values: Record<string, unknown> }[] };
    expect(exported.items[0]?.values.rated_head).toBeUndefined();
  });
});
