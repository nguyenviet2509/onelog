# Multi-stage build — slim runtime, no build tools.
FROM python:3.12-slim AS builder

WORKDIR /build
RUN pip install --no-cache-dir --upgrade pip build
COPY pyproject.toml ./
COPY src ./src
RUN pip wheel --no-cache-dir --no-deps --wheel-dir /wheels . \
    && pip wheel --no-cache-dir --wheel-dir /wheels .

FROM python:3.12-slim AS runtime

COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links=/wheels onelog-indexer \
    && rm -rf /wheels \
    && mkdir -p /data/drain_state

# Runs as root inside the container — container isolation is the security
# boundary for this internal log server. Bind-mounted /data inherits root,
# which is fine here; non-root + bind mounts requires host-side chown dance
# that adds ops complexity without real benefit at this stage.
WORKDIR /

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 9100
ENTRYPOINT ["onelog-indexer"]
