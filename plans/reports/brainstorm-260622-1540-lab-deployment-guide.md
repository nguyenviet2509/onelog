# Brainstorm — Lab Deployment Guide for onelog RAG stack (3-VM)

- Date: 2026-06-22 15:40
- Plan: `260622-1056-rag-logserver-victorialogs`
- Deliverable: [docs/deployment-guide.md](../../docs/deployment-guide.md)

## Problem statement
Cần guide thực thi để deploy + smoke test onelog stack trên lab 3 VM (logserver 192.168.122.53; client srv-01 .52, srv-02 .51) sau khi cook xong code các phase. Mục đích: kiểm tra E2E ingest → redact → index → RAG chat → web UI trên môi trường thực, trước khi tính production.

## Constraints / assumptions
- Subnet nội bộ 192.168.122.0/24, không có public DNS / Let's Encrypt.
- Auth defer theo plan → IP whitelist + TLS self-signed lab.
- VM Ubuntu LTS, docker compose single-node (per Phase 01).
- 2 client chỉ là log source, không chạy stack.
- LLM egress đi internet (Anthropic + OpenAI).

## Approaches evaluated

### A. Single doc `docs/deployment-guide.md` (chosen)
- Pros: 1 file, kebab path chuẩn theo plan; chứa cả install + smoke test + rollback; mapping 1-1 với Phase 01–06; dễ duy trì.
- Cons: file dài (~300 dòng), section nhiều.

### B. Tách `deploy/` directory + nhiều file per phase
- Pros: modular, mỗi phase 1 file.
- Cons: redundant với `plans/.../phase-XX.md`; navigation 2 nơi; YAGNI cho lab guide.

### C. Ansible playbook thay vì doc
- Pros: idempotent, reproducible.
- Cons: over-engineer cho 3-VM lab; team chưa setup Ansible; chậm hơn doc + manual.

→ Chọn **A**. KISS: lab test cần copy-paste runnable, không cần automation framework.

## Final design (mirrors deployment-guide.md)
- Sec 1 Topology ASCII (3 VM, port matrix).
- Sec 2 Prereq per VM (apt, ntp).
- Sec 3 Logserver deploy: ssh hardening → UFW → docker → clone → `.env` → `docker compose up` → systemd.
- Sec 4 Client config: Option A rsyslog UDP 514 (smoke); Option B Vector agent (prod-grade).
- Sec 5 Smoke tests theo thứ tự dependency: health → ingest → redaction → indexer/Qdrant → RAG /api/chat → Web UI → alert.
- Sec 6 Checklist Done/Done.
- Sec 7 Troubleshooting table (symptom→check→fix).
- Sec 8 Rollback / wipe / restore snapshot.
- Sec 9 Lab→prod delta (DNS, LE, auth, TLS syslog, offsite snapshot).
- Sec 10 Open questions.

## Risks
- syslog UDP 514 drop dưới burst → guide nhắc Option B Vector agent (disk buffer) khi volume cao.
- Self-signed TLS → browser warning, có thể bị nhầm là sai cấu hình; doc nêu rõ accept exception ở lab.
- LLM key leak trong `.env` plaintext (lab bỏ sops cho nhanh) → cảnh báo trong Sec 9.
- Stack 10 service trên 16 vCPU/32GB: chấp nhận được; nếu VM nhỏ hơn cần down-scale (chưa cover, có thể bổ sung profile lab-mini).

## Success metrics
- Sau ≤ 2h follow guide: `docker compose ps` 10/10 healthy.
- E2E `logger` từ client → VL query có record < 10s.
- RAG `/api/chat` trả response + sources < 15s.
- Reboot logserver → stack tự up.

## Next steps
- User review deployment-guide.md.
- Nếu OK: bắt đầu cook Phase 01 theo guide; mismatch thực tế → cập nhật lại doc.
- Tùy chọn: chạy `/ck:plan` để tạo plan sub-task "execute lab deployment + capture evidence".

## Unresolved questions
1. Có DNS nội bộ để dùng `onelog.lab` thay IP raw không?
2. Volume log từ srv-01/02 ước lượng bao nhiêu MB/ngày để chọn rsyslog vs Vector agent?
3. Lab có MinIO/NAS để snapshot offsite không, hay accept local-only `/backup`?
4. LLM egress: direct internet hay qua corporate proxy?
5. VM spec lab thực tế có đúng 16 vCPU/32GB/1TB SSD theo Phase 01 không, hay nhỏ hơn cần profile "lab-mini"?
