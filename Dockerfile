# syntax=docker/dockerfile:1
# The API and the worker in one container (apps/api/dist/serve.js), as Render runs it.
# Build: docker build -t specledger-api .   Run: see docs/deployment.md.

FROM node:22-bookworm-slim AS build
ENV CI=1 TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@specledger/api...
# Keep only production dependencies for the runtime image.
RUN pnpm install --frozen-lockfile --prod --offline

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
# Replay recordings (the failover provider) and the corpus manifest (UPLOAD_ALLOWLIST=corpus).
COPY --from=build /app/fixtures/recordings ./fixtures/recordings
COPY --from=build /app/fixtures/corpus/manifest.json ./fixtures/corpus/manifest.json
# The demo workspace's documents: synthetic corpus PDFs, with the metadata their ground truth states.
COPY --from=build /app/fixtures/corpus/pdf ./fixtures/corpus/pdf
COPY --from=build /app/fixtures/corpus/truth ./fixtures/corpus/truth
USER node
EXPOSE 10000
CMD ["node", "apps/api/dist/serve.js"]
