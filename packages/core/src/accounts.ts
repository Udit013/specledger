import { z } from 'zod';

// Accounts for the real workspace: who may do what. A user holds one or more roles.
//   engineer  uploads documents and corrects extracted values (edit)
//   reviewer  accepts or rejects values and resolves conflicts
//   approver  publishes register versions
//   admin     manages users and operates the service (requeue jobs, reset the demo)
export const USER_ROLES = ['engineer', 'reviewer', 'approver', 'admin'] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

export const ACCOUNT_LIMITS = { email: 120, displayName: 80, passwordMin: 12, passwordMax: 200 };

// Stored lower-case; the audit log records "user:<email>".
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(ACCOUNT_LIMITS.email)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

export const newPasswordSchema = z
  .string()
  .min(ACCOUNT_LIMITS.passwordMin)
  .max(ACCOUNT_LIMITS.passwordMax);

const rolesSchema = z
  .array(userRoleSchema)
  .min(1)
  .max(USER_ROLES.length)
  .refine((roles) => new Set(roles).size === roles.length, 'roles must be distinct');

export const loginBodySchema = z.strictObject({
  email: z.string().trim().toLowerCase().min(1).max(ACCOUNT_LIMITS.email),
  password: z.string().min(1).max(ACCOUNT_LIMITS.passwordMax),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const userViewSchema = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  roles: z.array(userRoleSchema),
  disabled: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type UserView = z.infer<typeof userViewSchema>;

export const meSchema = z.strictObject({
  user: userViewSchema,
  expiresAt: z.iso.datetime({ offset: true }),
});
export type MeBody = z.infer<typeof meSchema>;

export const userListSchema = z.strictObject({ users: z.array(userViewSchema) });

export const createUserBodySchema = z.strictObject({
  email: emailSchema,
  displayName: z.string().trim().min(1).max(ACCOUNT_LIMITS.displayName),
  roles: rolesSchema,
  password: newPasswordSchema,
});
export type CreateUserBody = z.infer<typeof createUserBodySchema>;

export const updateUserBodySchema = z
  .strictObject({
    roles: rolesSchema.optional(),
    disabled: z.boolean().optional(),
    password: newPasswordSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;
