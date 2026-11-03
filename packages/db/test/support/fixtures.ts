import type { EquipmentRecord, ExtractionRunRecord, FieldRecord } from '@specledger/core';

import type { NewDocument, Repositories } from '../../src/repositories.js';

export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);
export const MISSING_ID = '00000000-0000-4000-8000-00000000dead';

export function newDocument(overrides: Partial<NewDocument> = {}): NewDocument {
  return {
    sha256: SHA_A,
    originalFilename: 'P-101 datasheet.pdf',
    byteSize: 2048,
    pageCount: 2,
    documentType: 'datasheet',
    revision: 'Rev A',
    ...overrides,
  };
}

export interface Seeded {
  readonly documentId: string;
  readonly equipment: EquipmentRecord;
  readonly run: ExtractionRunRecord;
  readonly field: FieldRecord;
}

// One document with an extraction run that produced one verified field for pump P-101.
export async function seedField(repos: Repositories, sha256 = SHA_A): Promise<Seeded> {
  const document = await repos.documents.insert(newDocument({ sha256 }));
  const equipment = await repos.equipment.insert({
    tag: `P-${sha256.slice(0, 6)}`,
    equipmentClass: 'centrifugal_pump',
  });
  const run = await repos.extractionRuns.insert({
    documentId: document.id,
    model: 'replay',
    promptVersion: 'v1',
    tokens: 1200,
    latencyMs: 850,
  });
  const field = await repos.fields.insert({
    extractionRunId: run.id,
    equipmentId: equipment.id,
    name: 'rated_flow',
    value: '500',
    unit: 'gpm',
    quote: 'Rated flow: 500 gpm',
    page: 1,
    verificationStatus: 'verified',
    verificationReasons: [],
  });
  return { documentId: document.id, equipment, run, field };
}
