FROM python:3.12-slim AS builder
WORKDIR /build
RUN pip install --no-cache-dir --upgrade pip build
COPY pyproject.toml ./
COPY src ./src
RUN pip wheel --no-cache-dir --no-deps --wheel-dir /wheels . \
    && pip wheel --no-cache-dir --wheel-dir /wheels .

FROM python:3.12-slim AS runtime
COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links=/wheels onelog-mcp-semantic \
    && rm -rf /wheels

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 9000
ENTRYPOINT ["onelog-mcp-semantic"]
