# Backup age key setup

Snapshot script encrypts each archive using `age` with the public key at `backup-age.pub` in this directory.

## Generate master key (once, on operator laptop)

```bash
age-keygen -o ~/.secrets/onelog-backup-master.key
```

Output stderr shows: `Public key: age1xxxxx...`

## Install public key

Create `infra/backup/backup-age.pub`:

```
# OneLog backup master public key
# Private key: Bitwarden entry "onelog-backup-master.key" + printed QR in safe
# Rotated: YYYY-MM-DD
age1xxxxx...
```

Commit this file. The private key stays OFF git — Bitwarden + printed QR (safe/vault).

## Verify round-trip

```bash
echo hello | age -R infra/backup/backup-age.pub | age -d -i ~/.secrets/onelog-backup-master.key
# → hello
```

## Rotate

Generate new keypair, replace `backup-age.pub`, keep old private key alive at least as long as oldest S3 archive (365d if using default lifecycle).

## Runtime install (onelog-vps)

```bash
sudo apt-get install -y age
```

Required for both `snapshot-daily.sh` (encrypt) and `restore-snapshot.sh` (decrypt).
