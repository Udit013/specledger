// A response contract as field names and their JSON types, nested for objects. The drift detector
// compares a response with it and reports what differs instead of failing on the first problem.
export type FieldType = 'string' | 'number' | 'boolean';

export interface ContractShape {
  readonly [key: string]: FieldType | ContractShape;
}

export interface DriftDifference {
  // Dotted path of the field; '' for the response itself.
  readonly path: string;
  readonly kind: 'added' | 'removed' | 'type_changed';
  readonly expected: string | null;
  readonly actual: string | null;
}

export interface DriftReport {
  // True when the response can still be read: it may carry extra fields, but nothing the contract
  // needs is missing or of another type.
  readonly compatible: boolean;
  // Sorted by path.
  readonly differences: readonly DriftDifference[];
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'non-finite number';
  return typeof value;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeOf(value) === 'object';

function compare(
  shape: ContractShape,
  value: Record<string, unknown>,
  prefix: string,
  out: DriftDifference[],
) {
  const join = (key: string) => (prefix === '' ? key : `${prefix}.${key}`);
  for (const [key, expected] of Object.entries(shape)) {
    const path = join(key);
    const expectedType = typeof expected === 'string' ? expected : 'object';
    if (!Object.hasOwn(value, key)) {
      out.push({ path, kind: 'removed', expected: expectedType, actual: null });
      continue;
    }
    const actual = value[key];
    if (typeof expected === 'string') {
      if (typeOf(actual) !== expected) {
        out.push({ path, kind: 'type_changed', expected, actual: typeOf(actual) });
      }
    } else if (isRecord(actual)) {
      compare(expected, actual, path, out);
    } else {
      out.push({ path, kind: 'type_changed', expected: 'object', actual: typeOf(actual) });
    }
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(shape, key)) {
      out.push({ path: join(key), kind: 'added', expected: null, actual: typeOf(value[key]) });
    }
  }
}

// Never throws: any input, including a non-object, gives a report.
export function detectDrift(shape: ContractShape, value: unknown): DriftReport {
  const differences: DriftDifference[] = [];
  if (isRecord(value)) {
    compare(shape, value, '', differences);
  } else {
    differences.push({ path: '', kind: 'type_changed', expected: 'object', actual: typeOf(value) });
  }
  differences.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { compatible: differences.every((d) => d.kind === 'added'), differences };
}
