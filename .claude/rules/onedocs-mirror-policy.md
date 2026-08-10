# OneDocs mirror policy (onelog)

Quy tắc cho junction `d:\Vietnt\Project\onelog\onedocs` → `D:\Vietnt\Project\onedocs`.

## Mục đích
Cho phép build/edit OneDocs (Docusaurus docs portal) trong session OneLog mà không phải chuyển CWD. Repo OneDocs là canonical source, junction chỉ là access shortcut.

## 2 chế độ (cùng pattern onemcp-mirror-policy)

### Chế độ A — READ-ONLY (mặc định)
Khi task không liên quan OneDocs:
- Chỉ `Read`, `Grep`, `Glob`, `LS` qua `d:\Vietnt\Project\onelog\onedocs\*`
- **KHÔNG** `Edit`, `Write` qua junction
- **KHÔNG** `git` trong junction path

### Chế độ B — COOK CROSS-PROJECT (khi task OneDocs)
Kích hoạt khi:
- Plan hiện tại touch OneDocs (VD plan portal docs, mcp-onedocs)
- Phase file liệt kê file OneDocs trong "files to modify/create"
- User yêu cầu thẳng ("cook onedocs", "build docs portal", "edit docs")

Trong chế độ B:
- ✅ Cho phép `Edit`, `Write` qua path junction `d:\Vietnt\Project\onelog\onedocs\...`
- ✅ Cho phép chạy `git`, `npm`, `pnpm`, `npx docusaurus build` **trong** `D:\Vietnt\Project\onedocs\` (absolute path, KHÔNG dùng junction cho git)
- ⚠️ **BẮT BUỘC** commit về repo gốc sau mỗi phase / batch hợp lý:
  1. `git -C D:\Vietnt\Project\onedocs status` → verify staged đúng
  2. `git -C D:\Vietnt\Project\onedocs commit` với conventional commit
  3. `git -C D:\Vietnt\Project\onedocs push` nếu plan/user yêu cầu
  4. **KHÔNG** để dirty state ở repo OneDocs khi kết thúc cook

## Git hygiene (bắt buộc)

- Path `onedocs/` đã có trong `.gitignore` OneLog → junction không bị commit vào OneLog repo
- Trước `git add` trong OneLog: verify không có `onedocs/` trong staged files
- **KHÔNG BAO GIỜ** chạy `git` với working directory = junction path — luôn dùng `git -C D:\Vietnt\Project\onedocs`

## OneDocs artifacts location

**Content docs** (markdown thật của portal) sống trong repo OneDocs: `D:\Vietnt\Project\onedocs\content\{onelog,onemcp,_shared}\`.

**Plan / report / mockup của việc build OneDocs** (dev context) → sống ở OneLog `plans/`, `plans/reports/`, `mockups/` theo pattern onemcp-mirror-policy. Không tự move sang OneDocs repo trừ khi user ra lệnh rõ.

## Reference paths trong docs/plans

- **Tool đọc**: `d:\Vietnt\Project\onelog\onedocs\...` (qua junction)
- **Command line / git**: `D:\Vietnt\Project\onedocs\...` (absolute)
- **Deploy build output**: `D:\Vietnt\Project\onedocs\build\` → rsync sang VPS `/opt/onelog/docs-site/`

## Build workflow chuẩn (từ OneLog session)

```bash
# Build (absolute path, không dùng junction)
cd /d/Vietnt/Project/onedocs && npm run build

# Verify
ls -la D:/Vietnt/Project/onedocs/build/

# Deploy (sau khi anh cấp domain)
rsync -a --delete D:/Vietnt/Project/onedocs/build/ onelog-vps:/opt/onelog/docs-site/
```

## Checklist kết thúc cook OneDocs

1. `git -C D:\Vietnt\Project\onedocs status` → clean
2. `git -C D:\Vietnt\Project\onedocs log --oneline -5` → thấy commit vừa tạo
3. `git -C d:\Vietnt\Project\onelog status` → không có `onedocs/` staged/untracked
4. Nếu plan yêu cầu push: `git -C D:\Vietnt\Project\onedocs push` verified
5. Plan/journal OneLog update phản ánh commit OneDocs (hash + message)
