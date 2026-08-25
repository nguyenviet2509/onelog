# ── Stage 1: build ──────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --prefer-offline

COPY . .

# Build args become VITE_ env vars at build time
ARG VITE_API_BASE_URL=/v1
ARG VITE_ZITADEL_ISSUER
ARG VITE_ZITADEL_CLIENT_ID
ARG VITE_ZITADEL_REDIRECT_URI
ARG VITE_REVIEW_MODE=false

ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_ZITADEL_ISSUER=$VITE_ZITADEL_ISSUER
ENV VITE_ZITADEL_CLIENT_ID=$VITE_ZITADEL_CLIENT_ID
ENV VITE_ZITADEL_REDIRECT_URI=$VITE_ZITADEL_REDIRECT_URI
ENV VITE_REVIEW_MODE=$VITE_REVIEW_MODE

RUN npm run build

# ── Stage 2: serve ──────────────────────────────────────────
FROM nginx:1.27-alpine AS runner

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
