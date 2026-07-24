# Host Sync Policy (onelog)

Quy tắc đồng bộ giữa source code local và các host của OneLog.

## Vai trò host

| Host | Vai trò | Trạng thái sync |
|---|---|---|
| **onelog-vps** | **Production** (edge, Caddy, TLS) | ↔ Sync 2 chiều với local (canonical) |
| **onelog-source** | **Lab / test** (thử nghiệm, debug, phá) | ↓ Chỉ nhận từ local (không đẩy ngược) |
| **local repo** (d:\Vietnt\Project\onelog) | Nguồn sự thật (source of truth) | Là canonical, push lên origin/master |

## Quy tắc BẮT BUỘC

### 1. onelog-source = một chiều (local → source)
- **KHÔNG** commit code / config / bất cứ thay đổi nào từ `onelog-source` về local repo
- **KHÔNG** dùng `onelog-source` làm nguồn để `git pull` về máy khác
- Mọi thay đổi trên `onelog-source` được coi là **throw-away** (thử xong bỏ)
- Cho phép chạy `git reset --hard origin/master` bất kỳ lúc nào trên `onelog-source` mà không cần review
- Được phép: `git pull` / `rsync` từ local xuống `onelog-source` để test config mới

### 2. onelog-vps = hai chiều, có kỷ luật
- Áp dụng full policy VPS↔local sync gốc:
  - Sau bất kỳ thay đổi SSH nào trên `/opt/onelog` ở VPS → commit về local repo → push `origin/master` → reset VPS về `origin/master`
  - VPS end-state = `git status` sạch, khớp `origin/master`
- Chỉ `onelog-vps` mới được coi là canonical infra state

### 3. Khi phát hiện diff trên onelog-source
- **KHÔNG** hỏi "commit về không?" — mặc định **discard**
- Nếu thay đổi có giá trị: chép sang local → test lại từ local → mới sync xuống `onelog-vps`
- Không bao giờ đi thẳng `onelog-source` → `onelog-vps`

### 4. Runtime state (không phải file)
- `docker update` (restart policy, resource limits), `docker stop/start` trên `onelog-source` = OK, không cần sync
- Cùng loại thao tác trên `onelog-vps` = phải phản ánh vào `docker-compose.yml` trên local

## Lý do (Why)
- `onelog-source` là môi trường phá / thử nghiệm free-form → tránh làm bẩn repo bởi các thay đổi tạm
- Chỉ `onelog-vps` phản ánh cấu hình production thật → đó mới là source-of-truth cho infra
- Local repo là nơi review, ký, và push lên GitHub

## Cách áp dụng (How)
- Trước khi commit thay đổi liên quan tới host, xác định host nguồn:
  - Nguồn = `onelog-source`? → **STOP**, tự hỏi có cần chép về local rồi test lại từ local không
  - Nguồn = `onelog-vps`? → OK, tiếp tục theo policy sync gốc
- Trong hội thoại, khi user nói "SSH vào onelog-source làm X" → hiểu là thao tác tạm, không tự động đề xuất commit trừ khi user yêu cầu rõ
