import { notImplemented } from '../not-implemented.js';
export type FieldType = 'string' | 'number' | 'boolean';
export interface ContractShape {
  readonly [key: string]: FieldType | ContractShape;
}
export interface DriftDifference {
  readonly path: string;
  readonly kind: 'added' | 'removed' | 'type_changed';
  readonly expected: string | null;
  readonly actual: string | null;
}
export interface DriftReport {
  readonly compatible: boolean;
  readonly differences: readonly DriftDifference[];
}
export function detectDrift(shape: ContractShape, value: unknown): DriftReport {
  return notImplemented('detectDrift', shape, value);
}
