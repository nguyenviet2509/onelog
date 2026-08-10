# Host Sync Policy (onelog)

Quy tắc đồng bộ giữa source code local và các host của phòng KT (OneLog + OneMCP + OneDocs).

## Vai trò host

| Host | Repo canonical | Vai trò | Sync |
|---|---|---|---|
| **onelog-vps** | onelog | **Production** OneLog (edge, Caddy, TLS) | ↔ 2 chiều local↔VPS |
| **onemcp-vps** | onemcp | **Production** OneMCP (portal, MCP servers) | ↔ 2 chiều local↔VPS |
| **onedocs-vps** *(TBD)* | onedocs | **Production** OneDocs (docs portal) | ↔ 2 chiều local↔VPS |
| **onelog-source** *(192.168.122.53)* | onelog / cross-project | **Lab / test** OneLog (throw-away) | ↓ 1 chiều local→source |
| **onemcp-source** *(192.168.122.56)* | onemcp / onedocs / cross-project | **Lab / test** OneMCP + OneDocs (throw-away) | ↓ 1 chiều local→source |
| **local repo** | tương ứng | Source of truth | Push GitHub `origin/master` (hoặc `main`) |

## Quy tắc BẮT BUỘC

### 1. `*-source` (lab) = một chiều local → source
Áp dụng cho **cả `onelog-source` và `onemcp-source`**:
- **KHÔNG** commit code / config / bất cứ thay đổi nào từ lab về local repo
- **KHÔNG** dùng lab làm nguồn để `git pull` về máy khác
- Mọi thay đổi trên lab = **throw-away** (thử xong bỏ)
- Cho phép `git reset --hard origin/<branch>` bất kỳ lúc nào trên lab mà không cần review
- Được phép: `git push lab` / `rsync` / SSH edit từ local xuống lab để test

### 2. `*-vps` (prod) = hai chiều, có kỷ luật
Áp dụng cho **cả `onelog-vps`, `onemcp-vps`, `onedocs-vps` (khi có)**:
- Sau bất kỳ SSH edit nào trên prod → commit về local repo tương ứng → push `origin/master|main` → reset VPS về remote
- VPS end-state = `git status` sạch, khớp remote
- Chỉ prod VPS mới được coi là canonical infra state

### 3. Khi phát hiện diff trên lab (`*-source`)
- **KHÔNG** hỏi "commit về không?" — mặc định **discard**
- Nếu thay đổi có giá trị: chép sang local → test lại từ local → mới sync xuống lab lại (rồi mới push prod)
- Không bao giờ đi thẳng lab → prod

### 4. Runtime state (không phải file)
- `docker update` (restart policy, resource limits), `docker stop/start` trên lab = OK, không cần sync
- Cùng thao tác trên prod = phải phản ánh vào `docker-compose.yml` trên local

### 5. Mapping repo ↔ host cho task cross-project
Khi cook chạm nhiều repo:

| Repo | Prod | Lab |
|---|---|---|
| OneLog | onelog-vps | onelog-source |
| OneMCP | onemcp-vps | onemcp-source |
| OneDocs | onedocs-vps (TBD) | **onemcp-source** (dùng chung, không tách lab riêng) |

**OneDocs lab dùng chung `onemcp-source`** để tiết kiệm resource (docs site nhẹ, không xung đột port với OneMCP lab). Prod tách hẳn `onedocs-vps` riêng khi cấp.

## Lý do (Why)
- Lab (`*-source`) = môi trường phá / thử nghiệm free-form → tránh làm bẩn repo bởi thay đổi tạm
- Chỉ prod VPS phản ánh cấu hình production thật → source-of-truth cho infra
- Local repo là nơi review, ký, push GitHub
- Rule chung cho tất cả host cùng loại → dễ nhớ, ít exception

## Cách áp dụng (How)
- Trước khi commit thay đổi liên quan host, xác định host nguồn:
  - Nguồn = `*-source` (lab)? → **STOP**, tự hỏi có cần chép về local rồi test lại từ local không
  - Nguồn = `*-vps` (prod)? → OK, tiếp tục theo sync policy
- Trong hội thoại, khi user nói "SSH vào <host>-source làm X" → hiểu là thao tác tạm, không tự động đề xuất commit trừ khi user yêu cầu rõ
- Khi user nói "deploy lab" → default target = lab của repo hiện tại (VD deploy OneDocs → onemcp-source)
