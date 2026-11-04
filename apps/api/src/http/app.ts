import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { ApiErrorCode } from '@specledger/core';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';

import { registerAuth } from './auth.js';
import type { RouteAuth } from './auth.js';
import type { AppDeps } from './deps.js';
import { ApiError } from './errors.js';
import { registerRoutes } from './routes.js';

export type { AppDeps, HttpOptions } from './deps.js';

export interface RouteInfo {
  readonly method: string;
  readonly url: string;
  readonly auth: RouteAuth;
}

declare module 'fastify' {
  interface FastifyInstance {
    // Every registered route with its declared auth, for the authorization matrix.
    routeTable: readonly RouteInfo[];
  }
}

// A client's X-Request-Id is kept only if it is short and plain; anything else is replaced, so a
// header cannot inject text into logs or responses.
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

// Framework errors (body parsing, content type, limits) by status, as the contract names them.
const FRAMEWORK_CODES: Readonly<Record<number, ApiErrorCode>> = {
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};
const FRAMEWORK_MESSAGES: Readonly<Partial<Record<ApiErrorCode, string>>> = {
  PAYLOAD_TOO_LARGE: 'The request body is larger than the limit.',
  UNSUPPORTED_MEDIA_TYPE: 'The request body has an unsupported content type.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  VALIDATION_FAILED: 'The request is invalid.',
};

const isFrameworkError = (error: unknown): error is FastifyError =>
  error instanceof Error &&
  typeof (error as Partial<FastifyError>).statusCode === 'number' &&
  typeof (error as Partial<FastifyError>).code === 'string';

// The HTTP API (spec 6.3), ready for app.inject in tests or app.listen in main. Nothing listens
// until the caller does.
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { http } = deps;
  const hops = http.trustProxy;
  const app = Fastify({
    ...(deps.logger === undefined ? { logger: false } : { loggerInstance: deps.logger }),
    // Fastify's own request logs carry URLs and headers; the hook below logs ids and statuses.
    disableRequestLogging: true,
    bodyLimit: http.bodyLimitBytes,
    requestTimeout: http.requestTimeoutMs,
    // A hop count trusts that many proxies nearest the server, as proxy-addr counts them.
    trustProxy: typeof hops === 'number' ? (_address: string, hop: number) => hop < hops : hops,
    requestIdHeader: false,
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      return typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();
    },
  });

  const routeTable: RouteInfo[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const auth = (route.config as { auth?: RouteAuth } | undefined)?.auth;
    if (auth === undefined) return;
    for (const method of methods) routeTable.push({ method, url: route.url, auth });
  });

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        correlationId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? null,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
    }
    if (isFrameworkError(error) && error.statusCode !== undefined && error.statusCode < 500) {
      const code = FRAMEWORK_CODES[error.statusCode] ?? 'VALIDATION_FAILED';
      return reply
        .status(code === 'VALIDATION_FAILED' ? 400 : error.statusCode)
        .send({ error: { code, message: FRAMEWORK_MESSAGES[code] ?? 'The request is invalid.' } });
    }
    // Anything else is a bug or an outage. Its message and stack may hold SQL, paths or data, so
    // neither is logged nor sent: only its kind and the correlation id to find this line by.
    request.log.error(
      {
        correlationId: request.id,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      'request failed',
    );
    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: 'An unexpected error occurred.',
        details: { correlationId: request.id },
      },
    });
  });
  app.setNotFoundHandler(async (_request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'There is no such route.' } }),
  );

  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: [...http.corsOrigins],
    methods: ['GET', 'POST', 'PATCH'],
    allowedHeaders: ['authorization', 'content-type', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
  });
  await app.register(rateLimit, {
    global: true,
    max: http.rateLimitPerMinute,
    timeWindow: 60_000,
    errorResponseBuilder: () =>
      new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again later.'),
  });
  await app.register(multipart, {
    limits: {
      fileSize: deps.limits.maxBytes,
      files: 1,
      fields: 10,
      fieldNameSize: 100,
      fieldSize: 1024,
      parts: 11,
      headerPairs: 50,
    },
  });
  registerAuth(app, deps.tokens);
  registerRoutes(app, deps);
  return app;
}
