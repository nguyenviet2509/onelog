# Multi-stage build — slim runtime, no build tools.
FROM python:3.12-slim AS builder

WORKDIR /build
RUN pip install --no-cache-dir --upgrade pip build
COPY pyproject.toml ./
COPY src ./src
RUN pip wheel --no-cache-dir --no-deps --wheel-dir /wheels . \
    && pip wheel --no-cache-dir --wheel-dir /wheels .

FROM python:3.12-slim AS runtime

# Non-root user — indexer only needs to write /data/drain_state
RUN useradd --create-home --uid 10001 indexer

COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links=/wheels onelog-indexer \
    && rm -rf /wheels

USER indexer
WORKDIR /home/indexer

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 9100
ENTRYPOINT ["onelog-indexer"]
