# Backup offsite (S3 / MinIO)

Extends [snapshot-daily.sh](../infra/scripts/snapshot-daily.sh) to push each daily archive to remote object storage. Restore path is `restore-snapshot.sh <s3://…>` — script auto-downloads then applies.

## Golden rules

- Bucket **must** be in a different failure domain than the log server (different region for AWS, different rack/site for MinIO). Same-host MinIO = defeats the purpose.
- Use bucket **lifecycle** policy for retention when possible (AWS + MinIO both support it) — cheaper and race-free vs. script-side purge.
- Restore drill **monthly** at minimum. An untested backup is not a backup.
- Do NOT commit AWS creds to git. Use systemd `EnvironmentFile=` (chmod 0400) if switching from cron to timer.

## Quick enable

```bash
# infra/.env
BACKUP_S3_ENABLE=true
BACKUP_S3_BUCKET=s3://onelog-backups
BACKUP_S3_PREFIX=daily/
# BACKUP_S3_ENDPOINT=https://minio.corp:9000    # unset for AWS S3
BACKUP_S3_KEEP_DAYS=0                            # 0 = rely on bucket lifecycle
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-southeast-1
```

Prereq: `aws` CLI installed on the log-server host (`apt install awscli` or the v2 installer).

## Cron

Already scheduled by [install-systemd-unit.sh](../infra/scripts/install-systemd-unit.sh) if used, else:

```cron
0 2 * * * /opt/onelog/infra/scripts/snapshot-daily.sh >> /var/log/ragstack-snapshot.log 2>&1
```

## Verify

```bash
# Trigger manually
bash infra/scripts/snapshot-daily.sh
# Expect final line "s3 upload → s3://onelog-backups/daily/onelog-…tar.gz"

# List remote
aws s3 ls s3://onelog-backups/daily/ | tail
```

## Restore drill (monthly)

```bash
# Pick latest remote archive
LATEST=$(aws s3 ls s3://onelog-backups/daily/ | awk '{print $NF}' | tail -1)

# Restore into a staging environment (NOT prod)
bash infra/scripts/restore-snapshot.sh "s3://onelog-backups/daily/$LATEST"

# Verify counts match pre-restore snapshot
curl 'http://localhost:9428/select/logsql/query?query=*&limit=1' | wc -l
curl -s -H "api-key: $QDRANT_API_KEY" http://localhost:6333/collections/log_templates | jq .result.points_count
```

## Recommended MinIO lifecycle rule

Delete objects older than 90 days:

```bash
mc alias set myminio https://minio.corp:9000 ADMIN SECRET
mc ilm add --expiry-days 90 myminio/onelog-backups
mc ilm ls myminio/onelog-backups
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `aws: command not found` | CLI missing | `apt install awscli` OR install v2 |
| `Unable to locate credentials` | env vars unset in cron context | Ensure `.env` is sourced by script (already handled) OR use `~/.aws/credentials` |
| `Could not connect to the endpoint URL` | Wrong `BACKUP_S3_ENDPOINT` | Verify with `aws --endpoint-url … s3 ls` outside cron |
| Upload times out on large archive | Long `snapshot-daily.sh` runtime past 5min | Increase cron timeout or use `aws s3 cp --cli-connect-timeout 60` |

## Unresolved

- Encryption at rest — script currently uploads plaintext. Add `--sse aws:kms` (AWS) or MinIO SSE-KMS if compliance requires.
- Cross-region replication — configure on the bucket, not in this script.
