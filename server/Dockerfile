# ── Build stage ───────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Install OpenSSL — Prisma needs it for Alpine's musl libc.
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies for a slimmer runtime layer.
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Same OpenSSL dependency at runtime, plus a non-root user.
RUN apk add --no-cache openssl tini && \
    addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/package.json ./package.json

USER app

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Tini reaps zombie processes (Node alone won't reap children from spawn calls).
ENTRYPOINT ["/sbin/tini", "--"]

# Run pending migrations before starting — keeps deploys idempotent.
# In a managed environment (Render/Fly/Railway) you can split this into a
# separate release command if you prefer.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
