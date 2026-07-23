"""Unit tests cho redact.py — chạy pytest local (không cần openwebui runtime)."""

import pytest

from redact import RedactBlocked, check_hard_block, redact, soft_redact


# ---------- hard block ----------

class TestHardBlock:
    def test_pem_private_key_blocks(self):
        text = "log dump:\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n"
        with pytest.raises(RedactBlocked) as ei:
            check_hard_block(text)
        assert ei.value.pattern_name == "pem_private_key"

    def test_openssh_key_blocks(self):
        with pytest.raises(RedactBlocked):
            check_hard_block("key = -----BEGIN OPENSSH PRIVATE KEY-----")

    def test_openai_key_blocks(self):
        with pytest.raises(RedactBlocked) as ei:
            check_hard_block("env OPENAI_KEY=sk-abc123DEF456ghi789JKL012mno345 done")
        assert ei.value.pattern_name == "openai_key"

    def test_aws_access_key_blocks(self):
        with pytest.raises(RedactBlocked) as ei:
            check_hard_block("AKIAIOSFODNN7EXAMPLE leaked in log")
        assert ei.value.pattern_name == "aws_access_key"

    def test_jwt_blocks(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9AAAABBBBCCCCDDDDEEEE.eyJzdWIiOiIxMjM0NTY3ODkwIn0AAAAAAA.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        with pytest.raises(RedactBlocked) as ei:
            check_hard_block(f"header Bearer {jwt}")
        assert ei.value.pattern_name == "jwt_token"

    def test_clean_text_passes(self):
        check_hard_block("nginx 502 spike sáng nay do php-fpm exhausted")


# ---------- soft redact ----------

class TestSoftRedact:
    def test_private_ip_10x(self):
        r = soft_redact("connect to 10.0.14.50 port 5432")
        assert "<REDACTED_PRIVATE_IP>" in r.text
        assert r.hits.get("private_ip") == 1
        assert "10.0.14.50" not in r.text

    def test_private_ip_192_168(self):
        r = soft_redact("db at 192.168.1.100")
        assert r.hits.get("private_ip") == 1

    def test_private_ip_172(self):
        r = soft_redact("docker net 172.20.0.1 and 172.15.0.1")
        # 172.20.x = private (16-31), 172.15.x = public
        assert r.hits.get("private_ip") == 1
        assert r.hits.get("public_ip") == 1

    def test_public_ip(self):
        r = soft_redact("upstream 8.8.8.8 responded")
        assert "<REDACTED_IP>" in r.text
        assert r.hits.get("public_ip") == 1

    def test_external_email(self):
        r = soft_redact("contact john@gmail.com not admin@inet.vn")
        assert "<REDACTED_EMAIL>" in r.text
        assert "admin@inet.vn" in r.text  # inet.vn kept
        assert r.hits.get("external_email") == 1

    def test_sensitive_path(self):
        r = soft_redact("open /home/user/.env and /root/.ssh/id_rsa")
        assert "<REDACTED_PATH>" in r.text
        assert r.hits.get("sensitive_path") == 2

    def test_multiple_patterns(self):
        r = soft_redact("srv 192.168.1.1 uses /opt/app/.env for user@evil.com")
        assert r.hits.get("private_ip") == 1
        assert r.hits.get("sensitive_path") == 1
        assert r.hits.get("external_email") == 1

    def test_clean_passthrough(self):
        r = soft_redact("nginx 502 fix done")
        assert not r.touched
        assert r.text == "nginx 502 fix done"


# ---------- full pipeline ----------

class TestPipeline:
    def test_hard_block_stops_before_soft(self):
        with pytest.raises(RedactBlocked):
            redact("log 10.0.0.1 sk-abcdefghijklmnop1234567890 endstr")

    def test_full_clean_flow(self):
        text = "nginx 502 spike, private srv 10.0.14.50, email admin@inet.vn, external ext@x.com"
        r = redact(text)
        assert "<REDACTED_PRIVATE_IP>" in r.text
        assert "<REDACTED_EMAIL>" in r.text
        assert "admin@inet.vn" in r.text
        assert r.hits.get("private_ip") == 1
        assert r.hits.get("external_email") == 1
