---
title: OneMCP private-IP access — routing decoupling từ Caddy OneLog
date: 2026-07-24
author: brainstormer
status: approved
---

# Problem

Team muốn truy cập OneMCP dashboard trực tiếp qua `http://10.200.0.44/` (private IP OneMCP), không đi qua Caddy OneLog. Mục tiêu: **tách coupling** — OneMCP down/up không ảnh hưởng OneLog edge, và ngược lại.

Hiện tại (2026-07-24, sau khi deploy OneMCP): team truy cập được `http://10.200.0.30/` (OneLog Caddy) qua VPN INET VN, **KHÔNG truy cập được `http://10.200.0.44/`**.

# Root cause (đã verify)

Không phải bug config OneMCP hay OneLog. Là **provider chưa mở route cho VPS mới**.

Bằng chứng:
- `traceroute 10.200.0.30` từ dev: hop 1 `10.0.16.1` → hop 2 `10.200.0.30` ✅
- `traceroute 10.200.0.44` từ dev: hop 1 `10.0.16.1` → hop 2+ timeout ❌
- Từ onemcp-vps ping `10.0.16.1` → 100% packet loss (VPN gateway không cùng L2 subnet)
- Onemcp-vps ↔ onelog-vps qua `10.200.0.0/24` OK (0.5ms) — subnet chuẩn

Provider INET VN đã cấu hình VPN gateway `10.0.16.1` route/NAT tĩnh cho `10.200.0.30` (onelog-vps, cấp phát trước). onemcp-vps mới lên chưa được add.

# Đánh giá 3 approaches

| # | Approach | Ai chịu công | UX | Time-to-live | Decouple Caddy |
|---|---|---|---|---|---|
| A | Provider push route `10.200.0.0/24` (hoặc `10.200.0.44/32`) | Provider (ticket) | ✅ URL literal `http://10.200.0.44/` | Days–weeks | ✅ Hoàn toàn |
| B | Self-host WireGuard/OpenVPN trên onemcp-vps | Ta setup + team cài client | ⚠ VPN kép | 1 buổi + rollout | ✅ Hoàn toàn |
| C | Caddy vhost `onemcp.local` trên onelog-vps (đã live) | Ta giữ nguyên | ✅ Ngay | 0 | ❌ Còn coupling |

## Loại trừ approach

- **NAT/DNAT trên onelog-vps chuyển 10.200.0.44 → onemcp-vps**: Không giải được. Client-side routing table không có 10.200.0.44/32 hoặc 10.200.0.0/24 → packet không đi qua onelog-vps.
- **Add secondary IP 10.200.0.44 alias onelog-vps eth1**: Xung đột với IP thật của onemcp-vps, phá subnet.
- **DNS trick**: DNS không giải vấn đề routing L3.

# Recommended: Two-phase (approved)

## Phase 1 — Ngay: gửi ticket provider

**Nội dung ticket (bản copy-paste):**

```
Chúng tôi mới cấp phát VPS onemcp-vps (public IP 202.92.5.113, private IP 
eth1: 10.200.0.44/24). VPS đã hoạt động, subnet nội bộ 10.200.0.0/24 với 
VPS cũ onelog-vps (10.200.0.30) đã thông.

Tuy nhiên từ VPN client (endpoint 103.57.222.245) chỉ truy cập được 
10.200.0.30, KHÔNG truy cập được 10.200.0.44. Traceroute cho thấy packet 
đi tới VPN gateway 10.0.16.1 thì bị drop.

Nhờ anh/chị bổ sung route/NAT trên VPN gateway để client có thể reach 
10.200.0.44 (hoặc mở full subnet 10.200.0.0/24). Cảm ơn.
```

**Trong thời gian chờ:** Team dùng `http://onemcp.local/` (Caddy vhost đã live, không mất gì).

## Phase 2 — Sau khi provider xác nhận

**Verify:**
```powershell
curl -k http://10.200.0.44/health
# Expected: {"status":"ok","service":"onemcp-portal",...}
```

**Nếu OK, tear-down Caddy vhost:**

1. Xóa block `http://onemcp.local {...}` trong `infra/caddy/Caddyfile` (24 dòng, ngay trên block Grafana admin)
2. Commit: `chore(caddy): remove onemcp.local vhost — team dùng private IP trực tiếp`
3. `deploy vps` skill → sync + restart Caddy
4. Verify `curl -H 'Host: onemcp.local' http://10.200.0.30/health` → 403 forbidden (không còn vhost)
5. Team update bookmark `http://onemcp.local/` → `http://10.200.0.44/`

**Đạt được:**
- OneMCP hoàn toàn không có edge trên onelog-vps
- Caddy OneLog config gọn lại, không dính OneMCP
- Team truy cập URL literal `http://10.200.0.44/` như mong muốn
- Nếu OneLog down: OneMCP vẫn truy cập được (và ngược lại)

# Fallback (nếu provider từ chối hoặc chậm quá 2 tuần)

Chuyển sang Approach B — self-host WireGuard trên onemcp-vps. Design brief:
- Install `wireguard` package + generate keypair
- Server config: listen UDP 51820, subnet client `10.200.9.0/24`, push route `10.200.0.0/24 via server`
- Firewall: mở UDP 51820 trên public 202.92.5.113, MASQUERADE cho subnet client
- Team: mỗi user 1 keypair, config file `.conf` copy-paste vào WireGuard client (Windows/macOS/Linux/mobile)
- Coexist với VPN INET VN: WG dùng route split, không conflict

Chi tiết setup: viết plan riêng khi cần.

# Rủi ro & mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Provider chậm phản hồi ticket | Team vẫn dùng Caddy vhost, không mất gì | Timeout 2 tuần → chuyển Approach B |
| Provider mở full `/24` gây bảo mật? | Low — 10.200.0.0/24 chỉ có 2 VPS ta, VPN client cũng là team ta | OneMCP nginx đã có USER_ALLOW_CIDR filter |
| Sau tear-down, team quên đổi bookmark | Truy cập fail | Ping team + doc lại URL mới |
| VPN client cache route cũ | Bookmark cũ vẫn chạy | Kill Caddy vhost sạch, không dependency ẩn |

# Success metrics

- ✅ `curl http://10.200.0.44/health` từ máy team qua VPN → HTTP 200
- ✅ `infra/caddy/Caddyfile` không còn block `onemcp.local`
- ✅ `docker exec ragstack-caddy caddy list-routes` không có onemcp
- ✅ Team confirm bookmark mới hoạt động

# Unresolved questions

- Provider có mở full `/24` hay chỉ `/32` cho `10.200.0.44`? Nếu chỉ `/32`, VPS thứ 3 sau này cần lặp lại ticket. Full `/24` tiện hơn dài hạn.
- Có nên thêm `10.200.0.44 onemcp` vào DNS internal (nếu có) hay chỉ dùng IP trần? Preference bạn?
- Team đã đồng bộ VPN client config đầy đủ chưa? Cần verify ai đó ngoài admin.
