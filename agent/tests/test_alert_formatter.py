"""Smoke checks on the Telegram message builder."""
from __future__ import annotations

from agent.alert_formatter import fingerprint, format_alert

ALERT = {
    "fingerprint": "abc123",
    "status": "firing",
    "labels": {
        "alertname": "SshBruteForce",
        "severity": "warning",
        "host": "srv-01",
        "service": "mock-sshd",
    },
    "annotations": {
        "summary": "SSH brute force suspected on srv-01",
        "description": "42 failed login attempts in 5m",
    },
    "startsAt": "2026-06-23T10:00:00Z",
}


def test_format_contains_essentials() -> None:
    body = format_alert(ALERT, "Triệu chứng: brute force. [mock-sshd:srv-01:2026-06-23T10:00:00Z]")
    assert "SshBruteForce" in body
    assert "srv-01" in body
    assert "mock-sshd" in body
    assert "warning" in body
    assert "*Triage*" in body
    assert "[mock-sshd:srv-01" in body


def test_format_handles_missing_triage() -> None:
    body = format_alert(ALERT, "")
    assert "no triage" in body.lower()


def test_fingerprint_uses_alertmanager_value() -> None:
    assert fingerprint(ALERT) == "abc123"


def test_fingerprint_fallback_when_missing() -> None:
    a = {"labels": {"alertname": "X", "host": "h", "service": "s"}}
    assert fingerprint(a) == "X|h|s"
