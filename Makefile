.PHONY: test-rsyslog test-rsyslog-mandatory test-rsyslog-full \
        test-rsyslog-up test-rsyslog-down

# ───── rsyslog → OneLog E2E test targets ──────────────────────────────────
# Prereq: OneLog stack up (docker compose -f infra/docker-compose.yml up -d)

# Spin up test rsyslog client container
test-rsyslog-up:
	docker compose -f tests/rsyslog-e2e/docker-compose.test.yml up -d --build

test-rsyslog-down:
	docker compose -f tests/rsyslog-e2e/docker-compose.test.yml down -v

# Mandatory subset: schema + PII + severity routing (~30s)
test-rsyslog-mandatory:
	@bash tests/rsyslog-e2e/scenarios/b-schema-robustness.sh
	@bash tests/rsyslog-e2e/scenarios/c-pii-redaction-matrix.sh
	@bash tests/rsyslog-e2e/scenarios/d-severity-routing.sh

# Recommended: mandatory + coexistence + resilience
test-rsyslog: test-rsyslog-mandatory
	@bash tests/rsyslog-e2e/scenarios/e-coexistence.sh
	@bash tests/rsyslog-e2e/scenarios/f-resilience.sh
	@echo ""
	@echo "=== ALL rsyslog E2E scenarios passed ==="

# Future: add load + security negative scenarios when needed
test-rsyslog-full: test-rsyslog
	@echo "(load + security negative not implemented in this plan)"
