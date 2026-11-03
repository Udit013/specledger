import { z } from 'zod';

export const EQUIPMENT_CLASSES = ['centrifugal_pump', 'electric_motor'] as const;
export const equipmentClassSchema = z.enum(EQUIPMENT_CLASSES);
export type EquipmentClass = z.infer<typeof equipmentClassSchema>;

// Each dimension has one canonical unit. Values are normalized to it before range checks and
// comparison. Canonical units are SI except rotational speed (rpm, the only unit datasheets use)
// and efficiency (percent).
export const CANONICAL_UNITS = {
  volumetric_flow: 'm3/s',
  length: 'm',
  power: 'W',
  rotational_speed: 'rpm',
  pressure: 'Pa',
  voltage: 'V',
  current: 'A',
  frequency: 'Hz',
  efficiency: '%',
  temperature: 'K',
} as const;

export type Dimension = keyof typeof CANONICAL_UNITS;
export const DIMENSIONS = Object.keys(CANONICAL_UNITS) as [Dimension, ...Dimension[]];
export const dimensionSchema = z.enum(DIMENSIONS);

// scalar: exactly one value is acceptable. scalar_or_range: a stated range such as
// "2900 to 3600 rpm" is legitimate and must be kept with both bounds, never collapsed to one.
export const FIELD_KINDS = ['scalar', 'scalar_or_range'] as const;
export const fieldKindSchema = z.enum(FIELD_KINDS);
export type FieldKind = z.infer<typeof fieldKindSchema>;

export const fieldNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'field names are lower snake_case')
  .max(64);

export const fieldDefinitionSchema = z
  .strictObject({
    name: fieldNameSchema,
    dimension: dimensionSchema,
    canonicalUnit: z.string().min(1),
    kind: fieldKindSchema,
    // Plausible range in the canonical unit. It is a sanity guard against misread values,
    // not an engineering limit. Zod 4 numbers already reject NaN and Infinity.
    plausibleRange: z.strictObject({ min: z.number(), max: z.number() }),
  })
  .refine((def) => def.plausibleRange.min < def.plausibleRange.max, {
    message: 'plausibleRange.min must be below plausibleRange.max',
    path: ['plausibleRange'],
  })
  .refine((def) => def.canonicalUnit === CANONICAL_UNITS[def.dimension], {
    message: 'canonicalUnit must be the canonical unit of the dimension',
    path: ['canonicalUnit'],
  });

export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;

function field(
  name: string,
  dimension: Dimension,
  plausibleRange: { min: number; max: number },
  kind: FieldKind = 'scalar',
): FieldDefinition {
  return { name, dimension, canonicalUnit: CANONICAL_UNITS[dimension], kind, plausibleRange };
}

export const FIELD_DEFINITIONS: Readonly<Record<EquipmentClass, readonly FieldDefinition[]>> = {
  centrifugal_pump: [
    field('rated_flow', 'volumetric_flow', { min: 1e-5, max: 10 }),
    field('rated_head', 'length', { min: 0.5, max: 3000 }),
    field('rated_speed', 'rotational_speed', { min: 100, max: 30000 }, 'scalar_or_range'),
    field('rated_power', 'power', { min: 100, max: 20e6 }),
    field('efficiency', 'efficiency', { min: 1, max: 100 }),
    field('npsh_required', 'length', { min: 0.1, max: 100 }),
    field('max_working_pressure', 'pressure', { min: 1e4, max: 5e7 }),
    field('design_temperature', 'temperature', { min: 173.15, max: 773.15 }),
  ],
  electric_motor: [
    field('rated_power', 'power', { min: 100, max: 50e6 }),
    field('rated_voltage', 'voltage', { min: 100, max: 15000 }),
    field('rated_current', 'current', { min: 0.1, max: 5000 }),
    field('frequency', 'frequency', { min: 45, max: 65 }),
    field('rated_speed', 'rotational_speed', { min: 100, max: 30000 }, 'scalar_or_range'),
    field('efficiency', 'efficiency', { min: 50, max: 100 }),
  ],
};

export function fieldDefinitionsFor(equipmentClass: EquipmentClass): readonly FieldDefinition[] {
  return FIELD_DEFINITIONS[equipmentClass];
}
