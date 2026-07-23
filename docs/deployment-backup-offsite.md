# Backup offsite (S3) — age-encrypted, portable

Daily [snapshot-daily.sh](../infra/scripts/snapshot-daily.sh) bundles VictoriaLogs + Qdrant + Postgres + **secrets (.env, caddy TLS, alertmanager)**, encrypts with `age`, uploads to S3. [restore-snapshot.sh](../infra/scripts/restore-snapshot.sh) reverses it — including secrets — so a fresh VPS boots the stack immediately from `s3://…/onelog-*.tar.gz.age`.

## Golden rules

- **Never** commit the age private key. Bitwarden + printed QR in safe. Losing it = losing every backup.
- **Never** downgrade to plaintext archives. If age binary is missing, `apt install age` — do NOT bypass.
- **Never** upload a plaintext copy "just for backup". S3 SSE ≠ end-to-end encryption; a leaked IAM key still exposes secrets.
- Bucket **must** live in a different failure domain than onelog-vps (different region for AWS).
- Restore drill **after first setup** and after every age-key rotation. Untested backup ≠ backup.
- IAM user scoped to one bucket + one prefix. No wildcard resources.

## First-time setup

### 1. Generate age keypair (once, on operator laptop)

```bash
age-keygen -o ~/.secrets/onelog-backup-master.key
# Note the "Public key: age1..." line from stderr
```

Save the private key:
- Bitwarden Secure Note "onelog-backup-master.key" — full file content
- `qrencode -o key.png < ~/.secrets/onelog-backup-master.key` → print → safe

Commit the public key to `infra/backup/backup-age.pub` (see [infra/backup/README.md](../infra/backup/README.md)).

### 2. Install age on onelog-vps

```bash
sudo apt-get install -y age
age --version   # expect >= 1.1
```

### 3. Create S3 bucket + IAM user (AWS Console)

Bucket: e.g. `onelog-backups-<random>` in `ap-southeast-1`. Block all public access. Default encryption SSE-S3 (defence in depth on top of age).

IAM policy (attach to a dedicated user, save the access key pair):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow",
     "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
     "Resource": "arn:aws:s3:::<bucket-name>/daily/*"},
    {"Effect": "Allow",
     "Action": ["s3:ListBucket"],
     "Resource": "arn:aws:s3:::<bucket-name>",
     "Condition": {"StringLike": {"s3:prefix": ["daily/*"]}}}
  ]
}
```

Lifecycle rule (Management → Lifecycle rules):

| Age | Action |
|---|---|
| 30 days | Transition to STANDARD_IA |
| 90 days | Transition to GLACIER_IR |
| 365 days | Expire (delete) |

### 4. Enable in `infra/.env` on onelog-vps

**AWS S3:**
```bash
BACKUP_S3_ENABLE=true
BACKUP_S3_BUCKET=s3://<bucket-name>
BACKUP_S3_PREFIX=daily/
BACKUP_S3_KEEP_DAYS=0                    # 0 = bucket lifecycle handles retention
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-southeast-1
```

**S3-compatible provider (MinIO / Cloudflare R2 / 000nethost / Viettel / etc):**
```bash
BACKUP_S3_ENABLE=true
BACKUP_S3_BUCKET=s3://<bucket-name>
BACKUP_S3_PREFIX=daily/
BACKUP_S3_ENDPOINT=https://<endpoint-domain>
BACKUP_S3_KEEP_DAYS=7                    # script-side purge if provider lifecycle absent
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
AWS_REGION=us-east-1                     # dummy value; ignored when endpoint is custom
```

Prereq on host: `apt install awscli`.

## Schedule

Already installed by [install-systemd-unit.sh](../infra/scripts/install-systemd-unit.sh) — daily 02:00. Manual cron:

```cron
0 2 * * * /opt/onelog/infra/scripts/snapshot-daily.sh >> /var/log/ragstack-snapshot.log 2>&1
```

Local retention: 3 days. S3 retention: bucket lifecycle.

## Verify

```bash
# Trigger manually
bash infra/scripts/snapshot-daily.sh
# Expect final lines: "wrote /opt/onelog/backup/onelog-…tar.gz.age" + "s3 upload → s3://…"

# List remote
aws s3 ls s3://onelog-backups/daily/ | tail

# Smoke test decrypt (on laptop with private key)
aws s3 cp s3://<bucket>/daily/<latest>.tar.gz.age /tmp/
age -d -i ~/.secrets/onelog-backup-master.key /tmp/<latest>.tar.gz.age | tar -tzf - | head
# Expect: ./MANIFEST.json, ./SHA256SUMS, ./secrets/env, ./postgres-rag.sql, ./qdrant/, ./victorialogs.tar
```

## Restore drill (do this once after setup)

Run on a **throwaway** VPS (onelog-source lab is fine — see `.claude/rules/host-sync-policy.md`), never prod:

```bash
# On drill host, with docker + this repo checked out
export BACKUP_AGE_KEY=/tmp/onelog-backup-master.key   # scp from laptop, chmod 600
LATEST=$(aws s3 ls s3://<bucket>/daily/ | tail -1 | awk '{print $NF}')
FORCE=1 bash infra/scripts/restore-snapshot.sh "s3://<bucket>/daily/$LATEST"

# Verify counts
curl -s 'http://localhost:9428/select/logsql/query?query=*&limit=1' | wc -l
curl -s -H "api-key: $QDRANT_API_KEY" http://localhost:6333/collections | jq

# Cleanup on onelog-source lab
docker compose down -v
rm /tmp/onelog-backup-master.key
git reset --hard origin/master
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `age: command not found` | age not installed | `apt install age` on both source + target host |
| `ERROR age public key missing` | `infra/backup/backup-age.pub` absent | Follow first-time setup step 1 |
| `Set BACKUP_AGE_KEY=…` | Env var unset when restoring `.age` | `export BACKUP_AGE_KEY=/path/to/private.key` |
| `checksum mismatch — archive corrupted` | Bit rot in transit or storage | Re-download from S3; if persistent, restore from previous day |
| `Unable to locate credentials` | AWS creds not in cron env | Ensure `.env` sourced by script (already handled) |
| Restore overwrote wrong `.env` | Ran on prod by mistake | Recover from `.env.pre-restore-*` in `infra/` (script auto-saves) |
| Upload times out on large archive | Cron 5-min limit | `--cli-connect-timeout 60`; investigate VL data growth |

## DR — chuyển sang VPS mới

See [deployment-migrate.md](deployment-migrate.md) — step 6 now delegates to `restore-snapshot.sh` (script auto-restores `.env` + certs).

## Unresolved

- Cross-region replication — configure on the bucket, not this script.
- Age key rotation cadence — currently manual. Recommend annually.
