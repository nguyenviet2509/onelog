#!/usr/bin/env python3
"""
Mock log generator for onelog pipeline soak test.

Emits synthetic log lines via `logger` CLI → rsyslog → TCP 6514 → Vector → VictoriaLogs.
4 service formats (nginx/mysql/sshd/audit), weighted severity, optional PII injection
to verify Vector VRL redact zero-leak.

Env:
  MOCK_RATE       events/sec (default 10)
  MOCK_PII_RATE   fraction with PII (default 0.05)
  MOCK_DURATION   seconds; 0 = forever (default 0)

App-name tags `mock-<service>` — filter/disable easily when real logs arrive.
"""
from __future__ import annotations

import os
import random
import string
import subprocess
import sys
import time

RATE = float(os.getenv("MOCK_RATE", "10"))
PII_RATE = float(os.getenv("MOCK_PII_RATE", "0.05"))
DURATION = float(os.getenv("MOCK_DURATION", "0"))

SERVICE_WEIGHTS = [("nginx", 60), ("mysql", 20), ("sshd", 15), ("audit", 5)]
SEVERITY_WEIGHTS = [("info", 70), ("warning", 20), ("err", 10)]

# syslog facility used per service (local0..local3)
FACILITY = {"nginx": "local0", "mysql": "local1", "sshd": "local2", "audit": "local3"}

USERS = ["alice", "bob", "charlie", "dave", "ops", "deploy", "admin"]
PATHS = ["/", "/api/v1/users", "/api/v1/orders/42", "/login", "/static/app.js", "/healthz"]
METHODS = ["GET", "POST", "PUT", "DELETE"]
USER_AGENTS = [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "curl/8.4.0",
    "Go-http-client/1.1",
    "python-requests/2.31",
]


def weighted(choices):
    pool = [c for c, w in choices for _ in range(w)]
    return random.choice(pool)


def rand_public_ip() -> str:
    return f"{random.randint(1, 223)}.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"


def rand_private_ip() -> str:
    block = random.choice([10, 172, 192])
    if block == 10:
        return f"10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"
    if block == 172:
        return f"172.{random.randint(16, 31)}.{random.randint(0, 255)}.{random.randint(1, 254)}"
    return f"192.168.{random.randint(0, 255)}.{random.randint(1, 254)}"


def rand_email() -> str:
    user = "".join(random.choices(string.ascii_lowercase, k=6))
    return f"{user}@example.com"


def rand_jwt() -> str:
    seg = lambda n: "".join(random.choices(string.ascii_letters + string.digits + "_-", k=n))
    return f"eyJ{seg(20)}.{seg(40)}.{seg(30)}"


def rand_aws_key() -> str:
    return "AKIA" + "".join(random.choices(string.ascii_uppercase + string.digits, k=16))


def inject_pii(line: str) -> str:
    """Append a random PII fragment so redact transform has something to scrub."""
    pii = random.choice([
        f" user={rand_email()}",
        f" Authorization: Bearer {rand_jwt()}",
        f" aws_key={rand_aws_key()}",
        f" client_ip={rand_private_ip()}",
        f" password=hunter2-{random.randint(1000,9999)}",
    ])
    return line + pii


def line_nginx(sev: str) -> str:
    status = {"info": 200, "warning": 404, "err": 500}[sev]
    return (
        f'{rand_public_ip()} - - [{time.strftime("%d/%b/%Y:%H:%M:%S +0000", time.gmtime())}] '
        f'"{random.choice(METHODS)} {random.choice(PATHS)} HTTP/1.1" {status} '
        f'{random.randint(100, 50000)} "-" "{random.choice(USER_AGENTS)}"'
    )


def line_mysql(sev: str) -> str:
    code = {"info": "MY-010116", "warning": "MY-013360", "err": "MY-013183"}[sev]
    msgs = {
        "info": "InnoDB: Buffer pool(s) load completed",
        "warning": "Aborted connection to db",
        "err": "Got error 28 from storage engine",
    }
    return f"[{sev.upper()}] [{code}] [Server] {msgs[sev]}"


def line_sshd(sev: str) -> str:
    user = random.choice(USERS)
    ip = rand_public_ip()
    port = random.randint(30000, 60000)
    if sev == "err":
        return f"Failed password for invalid user {user} from {ip} port {port} ssh2"
    if sev == "warning":
        return f"pam_unix(sshd:auth): authentication failure; rhost={ip} user={user}"
    return f"Accepted publickey for {user} from {ip} port {port} ssh2"


def line_audit(sev: str) -> str:
    user = random.choice(USERS)
    pid = random.randint(1000, 9999)
    uid = random.randint(1000, 1100)
    msg_type = "USER_LOGIN" if sev != "err" else "USER_AUTH"
    result = "success" if sev == "info" else "failed"
    ts = int(time.time())
    return (
        f'type={msg_type} msg=audit({ts}.123:{pid}): pid={pid} uid={uid} '
        f'auid={uid} acct="{user}" exe="/usr/sbin/sshd" res={result}'
    )


GENERATORS = {
    "nginx": line_nginx,
    "mysql": line_mysql,
    "sshd": line_sshd,
    "audit": line_audit,
}


def emit(service: str, severity: str, line: str) -> None:
    """Fire via `logger` so rsyslog forward picks it up with proper appname tag."""
    subprocess.run(
        [
            "logger",
            "-t", f"mock-{service}",
            "-p", f"{FACILITY[service]}.{severity}",
            "--", line,
        ],
        check=False,
    )


def main() -> int:
    if RATE <= 0:
        print("MOCK_RATE must be > 0", file=sys.stderr)
        return 2
    interval = 1.0 / RATE
    deadline = time.time() + DURATION if DURATION > 0 else None
    count = 0
    start = time.time()
    next_log = start + 30

    while True:
        if deadline and time.time() >= deadline:
            break
        service = weighted(SERVICE_WEIGHTS)
        severity = weighted(SEVERITY_WEIGHTS)
        line = GENERATORS[service](severity)
        if random.random() < PII_RATE:
            line = inject_pii(line)
        emit(service, severity, line)
        count += 1

        now = time.time()
        if now >= next_log:
            elapsed = now - start
            print(f"emitted {count} lines in {elapsed:.1f}s ({count/elapsed:.1f} ev/s)", flush=True)
            next_log = now + 30

        time.sleep(interval)

    print(f"done — {count} lines emitted", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
