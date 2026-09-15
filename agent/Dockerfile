# Multi-stage build — runtime image carries only wheels, no build tools.
# Build context = project root (compose sets context: ..) so we can reach
# central-rbac-client/python for the RBAC SDK dep.
FROM python:3.12-slim AS builder

WORKDIR /build
RUN pip install --no-cache-dir --upgrade pip build

# 1. Wheel Central RBAC SDK first (agent depends on it)
COPY central-rbac-client/python /build/rbac-client
RUN pip wheel --no-cache-dir --wheel-dir /wheels /build/rbac-client

# 2. Wheel agent + transitive deps (find-links picks up the SDK wheel above)
COPY agent/pyproject.toml /build/agent/pyproject.toml
COPY agent/src /build/agent/src
RUN pip wheel --no-cache-dir --no-deps --wheel-dir /wheels /build/agent \
    && pip wheel --no-cache-dir --find-links=/wheels --wheel-dir /wheels /build/agent

FROM python:3.12-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links=/wheels onelog-agent \
    && rm -rf /wheels

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["onelog-agent"]
