import { z } from 'zod';

// Machine opinion about an extracted value. Kept apart from ReviewStatus (the human decision):
// a reviewer may accept an unverified value with a reason, or reject a verified one.
export const VERIFICATION_STATUSES = ['verified', 'unverified'] as const;
export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const VERIFICATION_REASONS = [
  'QUOTE_NOT_FOUND',
  'QUOTE_TOO_SHORT',
  'VALUE_NOT_IN_QUOTE',
  'UNIT_UNKNOWN',
  'UNIT_MISMATCH',
  'OUT_OF_RANGE',
  'AMBIGUOUS_NUMBER_FORMAT',
  'INTERNAL',
] as const;
export const verificationReasonSchema = z.enum(VERIFICATION_REASONS);
export type VerificationReason = z.infer<typeof verificationReasonSchema>;

export const REVIEW_STATUSES = ['pending', 'accepted', 'edited', 'rejected'] as const;
export const reviewStatusSchema = z.enum(REVIEW_STATUSES);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

// Source rank for reconciliation (Phase 6): datasheet above manual above brochure.
export const DOCUMENT_TYPES = ['datasheet', 'manual', 'brochure'] as const;
export const documentTypeSchema = z.enum(DOCUMENT_TYPES);
export type DocumentType = z.infer<typeof documentTypeSchema>;

export const CONFLICT_STATUSES = ['open', 'resolved'] as const;
export const conflictStatusSchema = z.enum(CONFLICT_STATUSES);
export type ConflictStatus = z.infer<typeof conflictStatusSchema>;

export const REVIEW_ACTIONS = [
  'extract',
  'accept',
  'edit',
  'reject',
  'resolve',
  'publish',
] as const;
export const reviewActionSchema = z.enum(REVIEW_ACTIONS);
export type ReviewAction = z.infer<typeof reviewActionSchema>;
