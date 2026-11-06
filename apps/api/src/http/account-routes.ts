import {
  createUserBodySchema,
  idParamsSchema,
  loginBodySchema,
  updateUserBodySchema,
} from '@specledger/core';
import type { UserView } from '@specledger/core';
import type { UserRecord } from '@specledger/db';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

import { dummyHash, hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  clearedSessionCookie,
  newSessionToken,
  sessionCookie,
  tokenHash,
} from '../auth/session-token.js';
import { credentialOf } from './auth.js';
import type { Role } from './auth.js';
import type { AppDeps } from './deps.js';
import { ApiError, notFound } from './errors.js';

const ANY: readonly Role[] = ['engineer', 'reviewer', 'approver', 'admin'];
const ADMIN: readonly Role[] = ['admin'];

export const userView = (user: UserRecord): UserView => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  roles: [...user.roles],
  disabled: user.disabledAt !== null,
  createdAt: user.createdAt.toISOString(),
});

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApiError(400, 'VALIDATION_FAILED', 'The request is invalid.', {
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
    })),
  });
}

const wrongCredentials = () =>
  new ApiError(401, 'UNAUTHENTICATED', 'The email or password is incorrect.');

// Sign-in, sign-out and the current user, and user administration for admins. Passwords are
// checked against scrypt hashes; an unknown email costs the same time as a wrong password and
// gets the same answer. A session is a random token whose SHA-256 is stored; the browser holds it
// in an HttpOnly cookie.
export function registerAccountRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { database, auth } = deps;
  const clock = deps.clock ?? (() => new Date());

  app.post(
    '/auth/login',
    {
      config: {
        auth: 'public',
        rateLimit: { max: auth.loginRateLimitPerMinute, timeWindow: 60_000 },
      },
    },
    async (request, reply) => {
      const body = parse(loginBodySchema, request.body);
      const user = await database.users.getByEmail(body.email);
      const valid = await verifyPassword(body.password, user?.passwordHash ?? (await dummyHash()));
      if (user === null || !valid || user.disabledAt !== null) throw wrongCredentials();
      const token = newSessionToken();
      const expiresAt = new Date(clock().getTime() + auth.sessionTtlMs);
      await database.sessions.create({ tokenHash: tokenHash(token), userId: user.id, expiresAt });
      request.log.info({ correlationId: request.id, userId: user.id }, 'signed in');
      return reply
        .header(
          'set-cookie',
          sessionCookie(token, Math.floor(auth.sessionTtlMs / 1000), auth.secureCookies),
        )
        .header('cache-control', 'no-store')
        .send({ user: userView(user), expiresAt: expiresAt.toISOString() });
    },
  );

  app.post('/auth/logout', { config: { auth: ANY } }, async (request, reply) => {
    const credential = credentialOf(request);
    if (credential !== null) await database.sessions.revoke(tokenHash(credential.token), clock());
    return reply.status(204).header('set-cookie', clearedSessionCookie(auth.secureCookies)).send();
  });

  app.get('/auth/me', { config: { auth: ANY } }, async (request, reply) => {
    const id = request.principal?.user?.id;
    const user = id === undefined ? null : await database.users.getById(id);
    if (user === null || request.principal?.user === undefined) throw notFound('user');
    return reply.header('cache-control', 'no-store').send({
      user: userView(user),
      expiresAt: request.principal.user.expiresAt.toISOString(),
    });
  });

  // ---- administration --------------------------------------------------------------------------

  app.get('/admin/users', { config: { auth: ADMIN } }, async () => ({
    users: (await database.users.list()).map(userView),
  }));

  app.post('/admin/users', { config: { auth: ADMIN } }, async (request, reply) => {
    const body = parse(createUserBodySchema, request.body);
    const created = await database.users.create({
      email: body.email,
      displayName: body.displayName,
      passwordHash: await hashPassword(body.password),
      roles: body.roles,
    });
    if (created === null)
      throw new ApiError(409, 'EMAIL_TAKEN', 'An account with this email exists.');
    request.log.info(
      { correlationId: request.id, userId: created.id, by: request.principal?.user?.id },
      'user created',
    );
    return reply.status(201).send(userView(created));
  });

  // Roles, disabling and passwords. Disabling a user or changing their password ends their
  // sessions. The last active admin cannot be disabled or lose the admin role, so the workspace
  // always has someone who can manage it.
  app.patch('/admin/users/:id', { config: { auth: ADMIN } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params);
    const body = parse(updateUserBodySchema, request.body);
    const passwordHash =
      body.password === undefined ? undefined : await hashPassword(body.password);
    const updated = await database.transaction(async (tx) => {
      const admins = await tx.users.lockActiveAdmins();
      const current = await tx.users.getById(id);
      if (current === null) throw notFound('user');
      const losesAdmin =
        admins.includes(id) &&
        (body.disabled === true || (body.roles !== undefined && !body.roles.includes('admin')));
      if (losesAdmin && admins.length === 1) {
        throw new ApiError(409, 'LAST_ADMIN', 'The last active admin cannot be removed.');
      }
      const user = await tx.users.update(id, {
        ...(body.roles === undefined ? {} : { roles: body.roles }),
        ...(body.disabled === undefined ? {} : { disabledAt: body.disabled ? clock() : null }),
        ...(passwordHash === undefined ? {} : { passwordHash }),
      });
      if (user === null) throw notFound('user');
      if (body.disabled === true || passwordHash !== undefined) {
        await tx.sessions.revokeAllForUser(id, clock());
      }
      return user;
    });
    request.log.info(
      { correlationId: request.id, userId: id, by: request.principal?.user?.id },
      'user updated',
    );
    return userView(updated);
  });
}
