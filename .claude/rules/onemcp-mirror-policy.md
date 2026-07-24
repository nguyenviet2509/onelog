# OneMCP mirror policy (onelog)

Quy tắc cho junction `d:\Vietnt\Project\onelog\onemcp` → `D:\Vietnt\Project\onemcp`.

## Mục đích
Cấp context OneMCP (source, docs, docker-compose) cho Claude khi làm việc trong project OneLog. Cho phép **cook cross-project** khi plan OneLog có phase đụng OneMCP (VD plan `260724-0821-onemcp-multidept-v1-5`), miễn tuân thủ sync policy dưới đây.

## 2 chế độ

### Chế độ A — READ-ONLY (mặc định)
Khi task **không liên quan tới OneMCP** (task đang làm về OneLog thuần):
- Chỉ dùng `Read`, `Grep`, `Glob`, `LS` với path `d:\Vietnt\Project\onelog\onemcp\*`
- **KHÔNG** `Edit`, `Write`, `NotebookEdit`
- **KHÔNG** `git` command trong `/onemcp`
- Nếu cần sửa OneMCP → dừng, đề xuất user chuyển session

### Chế độ B — COOK CROSS-PROJECT (khi task liên quan OneMCP)
Kích hoạt khi:
- Plan hiện tại rõ ràng touch OneMCP (VD plan `260724-0821-onemcp-multidept-v1-5`, `260723-1200-onemcp-openwebui-bridge`)
- Phase file liệt kê file OneMCP trong "files to modify/create"
- User yêu cầu thẳng ("cook OneMCP", "implement OneMCP feature X")

Trong chế độ B:
- ✅ Cho phép `Edit`, `Write` qua path junction `d:\Vietnt\Project\onelog\onemcp\...` — tương đương ghi vào `D:\Vietnt\Project\onemcp\...`
- ✅ Cho phép chạy `git`, `npm`, `pnpm`, build, test **trong** `D:\Vietnt\Project\onemcp\` (dùng absolute path, KHÔNG dùng junction)
- ⚠️ **BẮT BUỘC** sync đầy đủ về repo gốc:
  1. Sau mỗi phase / batch commit hợp lý, chạy `git` command với working dir = `D:\Vietnt\Project\onemcp` (absolute), KHÔNG dùng junction path
  2. Verify commit thành công: `git -C D:\Vietnt\Project\onemcp status` phải clean sau commit
  3. Push nếu user yêu cầu / plan yêu cầu: `git -C D:\Vietnt\Project\onemcp push`
  4. **KHÔNG** để state dirty trong repo OneMCP khi kết thúc cook — sẽ nhầm lẫn ở session sau

## Git hygiene (bắt buộc mọi chế độ)

- Path `onemcp/` đã có trong `.gitignore` của OneLog → junction không bị commit vào OneLog repo
- Trước khi `git add` trong OneLog: verify không có `onemcp/` trong staged files
- **KHÔNG BAO GIỜ** chạy `git` với working directory = junction path `d:\Vietnt\Project\onelog\onemcp` — sẽ ambiguous, dễ nhầm repo. Luôn dùng `git -C D:\Vietnt\Project\onemcp` với absolute path source

## Commit convention khi cook OneMCP

- Commit message: format conventional (feat/fix/chore/docs) — theo convention của repo OneMCP, không phải OneLog
- Reference plan OneLog trong commit body nếu hữu ích: `Refs: onelog plan 260724-0821-onemcp-multidept-v1-5 phase 1`
- Nếu cross-project commit (VD update bridge action OneLog + endpoint OneMCP cho cùng feature): tạo 2 commit riêng ở 2 repo, cross-reference qua plan slug

## OneMCP artifacts location

**Default (đang dev):** artifact OneMCP (plans, reports, mockups) sống ở OneLog `d:/Vietnt/Project/onelog/{plans,mockups}/` để Claude có context khi cook. OneLog `.gitignore` đã ignore `plans/*` → không lo commit nhầm plan vào git.

**Chỉ move sang OneMCP repo (`D:/Vietnt/Project/onemcp/`) KHI user ra lệnh rõ ràng** ("chuyển plan onemcp sang onemcp repo", "sync xong plan sang onemcp"). Không tự động move.

**Nguyên tắc chọn vị trí file mới liên quan OneMCP:**
- Plan / phase file OneMCP → `plans/` OneLog (dev context)
- Report OneMCP → `plans/reports/` OneLog
- Mockup UI OneMCP → `mockups/` OneLog (tracked ở OneLog repo cho tiện review)
- Code OneMCP thật (backend/portal/docker-compose) → sửa qua junction `d:/Vietnt/Project/onelog/onemcp/...`, commit trong repo OneMCP với absolute path

**Khi user "chuyển":** copy file sang `D:/Vietnt/Project/onemcp/{plans,mockups,docs}/`, commit onemcp repo (absolute path git), xóa khỏi OneLog + commit revert.

## Reference paths trong docs/plans

- **Cho tool đọc**: dùng `d:\Vietnt\Project\onelog\onemcp\...` (qua junction) → Read/Grep/Glob work
- **Cho command line / commit context**: dùng `D:\Vietnt\Project\onemcp\...` (absolute source) → rõ ràng, tránh git confusion
- **Cross-reference doc**: dùng bất kỳ, chọn cái rõ nghĩa hơn trong ngữ cảnh

## Lý do (Why)
- Cook plan v1.5 có 3/4 phase đụng backend + portal OneMCP → nếu bắt buộc chuyển session → workflow gãy, mất context
- Junction cho phép single-session cook cross-project → hiệu quả hơn
- Ràng buộc git absolute path đảm bảo không "orphan changes" (edit qua junction mà quên commit ở repo gốc)

## Checklist trước khi kết thúc cook OneMCP

1. `git -C D:\Vietnt\Project\onemcp status` → clean (không untracked / uncommitted)
2. `git -C D:\Vietnt\Project\onemcp log --oneline -5` → thấy commit vừa tạo
3. `git -C d:\Vietnt\Project\onelog status` → không có `onemcp/` trong staged/untracked
4. Nếu plan yêu cầu push: `git -C D:\Vietnt\Project\onemcp push` verified
5. Journal / plan status update ở OneLog phản ánh commit OneMCP (hash + message)
