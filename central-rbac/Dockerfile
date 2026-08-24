# Dockerfile — central-rbac
# Multi-stage: build → distroless runtime, non-root, healthcheck

# ---- Build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig*.json ./
COPY src/ ./src/

RUN npm run build

# Prune dev deps
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app

# Non-root user
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/v1/health || exit 1

CMD ["node", "dist/app.js"]
