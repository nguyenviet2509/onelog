-- 018_apps_revoke_webhook.sql — App-side immediate revoke webhook config.
--
-- Central-side implementation of "P2 immediate revoke" (2026-09-09).
--
-- Vấn đề: Sau admin revoke role của user trong Central, JWT session ở app-side (VD qlts) vẫn valid
-- tối đa TTL access token (~15min) + refresh token (~1 ngày). User vẫn truy cập được dashboard cho
-- đến khi token expire. Central không có cơ chế push revoke event tới app.
--
-- Fix: Mỗi app đăng ký `revoke_url` + `revoke_secret` trong Central. Sau khi Central revoke user
-- grant, outbox worker POST tới `revoke_url` với HMAC-SHA256 signature (msg = `${email}|revoke`).
-- App-side (VD qlts sso-revoke.controller.ts) xóa local session state → user bị đá ra ngay.
--
-- Backwards compat: 2 cột nullable. `revoke_url IS NULL` → skip notify (app không support).
--
-- Thừa kế: mọi app đăng ký trong `rbac.apps` đều hưởng — chỉ cần implement endpoint theo spec
-- Authway app-integration-spec §5.3.

ALTER TABLE rbac.apps
  ADD COLUMN IF NOT EXISTS revoke_url TEXT,
  ADD COLUMN IF NOT EXISTS revoke_secret TEXT;

COMMENT ON COLUMN rbac.apps.revoke_url IS
  'URL app-side revoke webhook (POST). NULL = app không support immediate revoke — Central skip notify, propagation qua login lại (max TTL access token).';

COMMENT ON COLUMN rbac.apps.revoke_secret IS
  'Shared secret (>=32-byte hex) để sign HMAC-SHA256 khi gọi revoke_url. PHẢI cùng giá trị SSO_REVOKE_SECRET env của app. Sinh: openssl rand -hex 32.';
