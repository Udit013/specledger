import { FIELD_DEFINITIONS } from '@specledger/core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';

import { encodeGrayscalePng } from './png.js';
import { randomFor } from './random.js';
import type { DocumentSpec, PrintedField } from './spec.js';
import type { FieldTruth, GroundTruth } from './truth.js';

// Fixed metadata so the same spec always produces the same bytes.
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const PRODUCER = 'SpecLedger synthetic corpus generator';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const VALUE_COLUMN = 300;
const BODY_SIZE = 10;

// A run of text drawn at one x position. Runs on the same line are separated by a visible gap, and
// page text reads them back joined by a single space (see extract.ts); a line's runs joined that
// way are therefore exactly the text a quote must match.
interface Run {
  readonly text: string;
  readonly x: number;
}

interface Line {
  readonly runs: readonly Run[];
  readonly size: number;
  readonly bold: boolean;
  readonly field?: string;
}

const lineText = (line: Line): string => line.runs.map((run) => run.text).join(' ');

function statement(field: PrintedField): string {
  return `${field.value} ${field.unit}${field.secondary === null ? '' : ` ${field.secondary}`}`;
}

const text = (value: string, size = BODY_SIZE, bold = false): Line => ({
  runs: [{ text: value, x: MARGIN }],
  size,
  bold,
});
const blank: Line = { runs: [], size: BODY_SIZE, bold: false };

function keyValue(field: PrintedField): Line {
  return { ...text(`${field.label}: ${statement(field)}`), field: field.name };
}

function tableRow(field: PrintedField): Line {
  return {
    runs: [
      { text: field.label, x: MARGIN },
      { text: statement(field), x: VALUE_COLUMN },
    ],
    size: BODY_SIZE,
    bold: false,
    field: field.name,
  };
}

const tableHeader: Line = {
  runs: [
    { text: 'Parameter', x: MARGIN },
    { text: 'Value', x: VALUE_COLUMN },
  ],
  size: BODY_SIZE,
  bold: true,
};

function prose(field: PrintedField): Line {
  return {
    ...text(
      `The ${field.label.toLowerCase()} is ${statement(field)} at the guaranteed duty point.`,
    ),
    field: field.name,
  };
}

function title(spec: DocumentSpec): string {
  if (spec.sourceType === 'brochure') return 'Process Pump Series - Product Brochure';
  return spec.equipmentClass === 'centrifugal_pump'
    ? 'Centrifugal Pump Datasheet'
    : 'Electric Motor Datasheet';
}

function header(spec: DocumentSpec, pageNumber: number): Line[] {
  const lines = [
    text('SYNTHETIC TEST DOCUMENT - NOT A REAL PRODUCT', 8),
    text(title(spec), 14, true),
    text(`Equipment tag: ${spec.tag}`),
  ];
  if (spec.revision !== null) lines.push(text(`Revision: ${spec.revision}`));
  if (spec.pageCount > 1) {
    lines.push(text(`Page ${String(pageNumber)} of ${String(spec.pageCount)}`));
  }
  lines.push(blank);
  return lines;
}

// Splits fields over pages: the first page carries the first half when there are two pages.
function fieldsByPage(spec: DocumentSpec): PrintedField[][] {
  if (spec.pageCount === 1) return [[...spec.fields]];
  if (spec.pageCount !== 2) throw new Error(`${spec.id}: only one or two pages are supported`);
  const half = Math.ceil(spec.fields.length / 2);
  return [spec.fields.slice(0, half), spec.fields.slice(half)];
}

function bodyLines(spec: DocumentSpec, fields: readonly PrintedField[], first: boolean): Line[] {
  switch (spec.layout) {
    case 'key_value':
      return fields.map(keyValue);
    case 'table':
      return fields.length === 0 ? [] : [tableHeader, ...fields.map(tableRow)];
    case 'mixed': {
      const proseCount = first ? 2 : 0;
      const sentences = fields.slice(0, proseCount).map(prose);
      const rows = fields.slice(proseCount).map(tableRow);
      return [...sentences, ...(rows.length > 0 ? [blank, tableHeader, ...rows] : [])];
    }
    case 'brochure': {
      const [intro, ...rest] = spec.notes;
      return [
        ...(intro === undefined ? [] : [text(intro), blank]),
        ...fields.map(keyValue),
        blank,
        ...rest.map((note) => text(note)),
      ];
    }
  }
}

function pageLines(spec: DocumentSpec): Line[][] {
  return fieldsByPage(spec).map((fields, index) => {
    const isLast = index === spec.pageCount - 1;
    const notes =
      spec.layout !== 'brochure' && isLast && spec.notes.length > 0
        ? [blank, ...spec.notes.map((note) => text(note))]
        : [];
    return [...header(spec, index + 1), ...bodyLines(spec, fields, index === 0), ...notes];
  });
}

function measure(font: PDFFont, line: Line, run: Run, id: string): void {
  const right = run.x === VALUE_COLUMN ? PAGE_WIDTH - MARGIN : VALUE_COLUMN - 12;
  const limit = line.runs.length === 1 ? PAGE_WIDTH - MARGIN : right;
  if (run.x + font.widthOfTextAtSize(run.text, line.size) > limit) {
    throw new Error(`${id}: "${run.text}" does not fit on its line`);
  }
}

async function renderTextDocument(
  spec: DocumentSpec,
  pdf: PDFDocument,
): Promise<Map<string, FieldTruth>> {
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const truths = new Map<string, FieldTruth>();
  const printed = new Map(spec.fields.map((field) => [field.name, field]));

  pageLines(spec).forEach((lines, pageIndex) => {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN;
    for (const line of lines) {
      const font = line.bold ? bold : regular;
      for (const run of line.runs) {
        measure(font, line, run, spec.id);
        page.drawText(run.text, { x: run.x, y, size: line.size, font });
      }
      if (line.field !== undefined) {
        const field = printed.get(line.field);
        if (field === undefined) throw new Error(`${spec.id}: unknown field ${line.field}`);
        truths.set(line.field, {
          value: field.value,
          unit: field.unit,
          page: pageIndex + 1,
          quote: lineText(line),
        });
      }
      y -= line.size * 1.7;
      if (y < MARGIN) throw new Error(`${spec.id}: page ${String(pageIndex + 1)} overflows`);
    }
  });
  return truths;
}

// A raster of "ink" bars where text lines would be, so the page looks scanned but has no text.
async function renderScannedDocument(spec: DocumentSpec, pdf: PDFDocument): Promise<void> {
  const width = PAGE_WIDTH;
  const height = PAGE_HEIGHT;
  const random = randomFor('scan', spec.id);
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = 240 + random.int(0, 12);
  for (let row = 0, y = MARGIN; row < 24; row += 1, y += 22) {
    const length = random.int(140, 440);
    for (let dy = 0; dy < 7; dy += 1) {
      for (let x = MARGIN; x < MARGIN + length; x += 1) {
        pixels[(y + dy) * width + x] = random.int(20, 70);
      }
    }
  }
  const image = await pdf.embedPng(encodeGrayscalePng(width, height, pixels));
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  page.drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
}

export interface RenderedDocument {
  readonly spec: DocumentSpec;
  readonly pdf: Uint8Array;
  readonly truth: GroundTruth;
}

export async function renderDocument(spec: DocumentSpec): Promise<RenderedDocument> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(`Synthetic ${spec.sourceType} ${spec.id}`);
  pdf.setAuthor(PRODUCER);
  pdf.setProducer(PRODUCER);
  pdf.setCreator(PRODUCER);
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);

  const truths = spec.textLayer
    ? await renderTextDocument(spec, pdf)
    : new Map<string, FieldTruth>();
  if (!spec.textLayer) await renderScannedDocument(spec, pdf);
  if (pdf.getPageCount() !== spec.pageCount) {
    throw new Error(`${spec.id}: rendered ${String(pdf.getPageCount())} pages`);
  }

  const fields: Record<string, FieldTruth | null> = {};
  for (const definition of FIELD_DEFINITIONS[spec.equipmentClass]) {
    fields[definition.name] = truths.get(definition.name) ?? null;
  }
  const truth: GroundTruth = {
    schemaVersion: 1,
    documentId: spec.id,
    lineageId: spec.lineageId,
    equipmentTag: spec.tag,
    equipmentClass: spec.equipmentClass,
    sourceType: spec.sourceType,
    revision: spec.revision,
    pageCount: spec.pageCount,
    textLayer: spec.textLayer,
    fields,
  };
  return { spec, pdf: await pdf.save(), truth };
}
