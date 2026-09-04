# Brainstorm — Backup onelog-vps → S3 (portable DR)

**Date:** 2026-07-23 09:46
**Scope:** Upload daily backup onelog-vps → AWS S3; đảm bảo file backup có thể restore trên VPS khác nếu prod chết.
**Không scope:** auto drill, alertmanager wiring, systemd timer refactor, bootstrap-vps.sh (YAGNI).

## 1. Problem statement

- Cần backup định kỳ toàn bộ state onelog-vps lên S3 offsite.
- File backup phải "portable": restore trên VPS mới → stack chạy lại được, không cần copy tay `.env`/TLS certs.
- Secrets trong backup phải mã hoá (leak S3 credential ≠ leak secrets).
- RPO chấp nhận: 24h.

## 2. Trạng thái hiện tại (đã scout)

| Cấu phần | File | Status |
|---|---|---|
| Daily snapshot Postgres + Qdrant + VL | `infra/scripts/snapshot-daily.sh` | ✅ có, chạy tốt |
| Upload S3 | same script (`BACKUP_S3_ENABLE=true`) | ✅ có |
| Restore từ S3 URI | `infra/scripts/restore-snapshot.sh` | ✅ có |
| Migrate runbook | `docs/deployment-migrate.md` | ✅ có (240 dòng manual) |
| Doc offsite | `docs/deployment-backup-offsite.md` | ✅ có |
| **Secrets (.env, TLS certs) trong archive** | — | ❌ **thiếu** |
| **Age encryption** | — | ❌ **thiếu** (doc tự flag "Unresolved") |
| **MANIFEST + SHA256SUMS** | — | ❌ thiếu |
| Age public key | `infra/backup/backup-age.pub` | ❌ chưa tạo |

Kết luận: **không cần viết lại từ đầu**, chỉ patch `snapshot-daily.sh` + `restore-snapshot.sh` + tạo age key.

## 3. Final design

### 3.1 Schedule

- Cron `0 2 * * *` (giữ nguyên). Retention local 3 ngày (giảm từ 7 → 3 vì đã có S3).
- S3 lifecycle policy (apply qua bucket, không script):
  - 0–30d: STANDARD
  - 30–90d: STANDARD_IA (~ –45% cost)
  - 90–365d: GLACIER_IR (~ –80% cost, retrieval <ms)
  - >365d: delete
- **Lý do daily**: log không phải revenue-path critical, snapshot 02:00 low-traffic, RPO 24h đủ, mọi option thấp hơn (hourly/incremental) đòi restic/pgBackRest → over-engineering.

### 3.2 Archive layout

```
onelog-YYYYMMDD-HHMM.tar.gz.age        (S3 object)
└── age decrypt + untar
    ├── MANIFEST.json          # git commit, image tags, hostname, timestamp
    ├── SHA256SUMS             # sha256 mọi blob bên trong
    ├── postgres-rag.sql       # đã có
    ├── qdrant/<col>/<snap>    # đã có
    ├── victorialogs.tar       # đã có
    └── secrets/               # ★ MỚI
        ├── env                # infra/.env
        ├── caddy/             # caddy_data + Caddyfile (TLS certs, CA)
        ├── alertmanager/      # config + templates
        └── mcp-tokens/        # gen-mcp-tokens output nếu có
```

### 3.3 Age encryption (asymmetric)

- 1 lần: laptop `age-keygen -o ~/onelog-backup-master.key`
- Public key → commit `infra/backup/backup-age.pub` (không nhạy cảm)
- Private key → **Bitwarden + 1 bản in QR két** (mất key = mất toàn bộ backup)
- VPS chỉ có public key → hack VPS ≠ decrypt được backup lịch sử

### 3.4 Files thay đổi

| File | Loại | Nội dung |
|---|---|---|
| `infra/backup/backup-age.pub` | mới | public key age (1 dòng) |
| `infra/scripts/snapshot-daily.sh` | patch | (a) bundle `secrets/`, (b) sinh `MANIFEST.json` + `SHA256SUMS`, (c) `age -R backup-age.pub` → `.tar.gz.age`, (d) upload `.age` |
| `infra/scripts/restore-snapshot.sh` | patch | detect `.age` → `age -d -i $BACKUP_AGE_KEY` trước untar. Nếu có `secrets/` → restore `.env` + certs (default yes, `--no-secrets` để opt-out) |
| `docs/deployment-backup-offsite.md` | rewrite | thêm age setup + secrets bundle + lifecycle recommend |
| `docs/deployment-migrate.md` | patch nhẹ | step 6 (Import .env) thay bằng `restore-snapshot.sh` tự lo |

### 3.5 DR flow (khi onelog-vps chết)

```bash
# Trên VPS mới, sau setup base (setup-log-server.sh)
export BACKUP_AGE_KEY=~/onelog-backup-master.key   # từ Bitwarden
LATEST=$(aws s3 ls s3://onelog-backups/daily/ | tail -1 | awk '{print $NF}')
bash infra/scripts/restore-snapshot.sh "s3://onelog-backups/daily/$LATEST"
docker compose up -d
```

MTTR mục tiêu: <30 phút (docker pull chiếm phần lớn).

## 4. Trade-offs

| Rủi ro | Mức | Mitigation |
|---|---|---|
| Mất age private key = mất toàn bộ backup | CAO | Bitwarden + QR giấy két riêng biệt |
| Archive size lớn (VL data explosion) | Trung | Monitor archive size trend Grafana, alert nếu >2x baseline |
| Restore .env đè lên .env đang chạy | Thấp | `restore-snapshot.sh` phải backup `.env` cũ thành `.env.pre-restore` |
| IAM key leak | Thấp | IAM user riêng, policy chỉ `PutObject` + `GetObject` + `ListBucket` trên 1 bucket |

## 5. Success criteria

- `snapshot-daily.sh` chạy 3 ngày liên tục không lỗi, S3 có 3 file `.age`.
- Test restore 1 lần trên VPS phụ (hoặc container local `docker-compose -p test`) → stack up, `curl localhost:9428/select/logsql/query?query=*&limit=1` trả kết quả.
- File backup gần nhất trên S3 luôn <30h tuổi (kiểm thủ công định kỳ).

## 6. Next steps

1. Sinh age key trên laptop, cất private key.
2. Commit `infra/backup/backup-age.pub`.
3. Patch `snapshot-daily.sh` (secrets bundle + manifest + age).
4. Patch `restore-snapshot.sh` (age decrypt + secrets restore).
5. Update 2 docs.
6. Chạy `snapshot-daily.sh` tay 1 lần trên onelog-vps, verify S3 có `.age`.
7. Manual restore drill 1 lần trên container test → PASS thì đóng session.

## 7. Unresolved

- **AWS bucket đã tồn tại chưa?** User sẽ cung cấp credential — cần biết bucket name + region để config `.env` (`BACKUP_S3_BUCKET`, `AWS_REGION`).
- **IAM policy scope**: có thể tạo IAM user chỉ scoped 1 bucket, hay user cung cấp root key? (khuyến nghị scoped user để giảm blast radius).
- **Bucket lifecycle**: apply qua AWS Console hay Terraform? (hiện repo chưa có IaC S3).
