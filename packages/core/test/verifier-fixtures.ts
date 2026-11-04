import type { Candidate } from '../src/candidate.js';
import { FIELD_DEFINITIONS } from '../src/equipment.js';
import type { FieldDefinition } from '../src/equipment.js';

// A pump datasheet page in the corpus layout, with dual units, a range and a temperature.
export const PUMP_PAGE = [
  'SYNTHETIC TEST DOCUMENT - NOT A REAL PRODUCT',
  'Centrifugal Pump Datasheet',
  'Equipment tag: P-101',
  'Rated flow: 287.0 m³/h (1264 gpm)',
  'Rated head: 45.2 m (148.3 ft)',
  'Rated speed: 2900 to 3600 rpm',
  'Rated power: 45.0 kW at 2900 rpm',
  'Efficiency: 78.5 %',
  'Max. working pressure: 16.0 bar',
  'Design temperature: 80 °C (176 °F)',
].join('\n');

export function pumpField(name: string): FieldDefinition {
  const field = FIELD_DEFINITIONS.centrifugal_pump.find((f) => f.name === name);
  if (field === undefined) throw new Error(`no pump field ${name}`);
  return field;
}

export const candidate = (
  fieldName: string,
  value: string,
  unit: string,
  quote: string,
): Candidate => ({ fieldName, value, unit, quote, page: 1 });

export function motorField(name: string): FieldDefinition {
  const field = FIELD_DEFINITIONS.electric_motor.find((f) => f.name === name);
  if (field === undefined) throw new Error(`no motor field ${name}`);
  return field;
}
