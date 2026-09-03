/**
 * pages/users/create-user-dialog.tsx — Admin creates a new Zitadel user
 * with one of 3 modes (matches Zitadel Console UX):
 *   • setup_later  — placeholder user, admin invites later
 *   • invite_email — Zitadel emails set-password link (needs SMTP config)
 *   • set_password — admin picks password; user must rotate on 1st login
 *
 * invite_email is auto-disabled when backend reports smtp_enabled=false so the
 * admin cannot accidentally trigger a silent-drop email. Once ops configures
 * SMTP + toggles ZITADEL_SMTP_ENABLED=true, the radio unlocks with no code change.
 */
import { useState, useMemo } from 'react';
import { Dialog, DialogContent, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCreateUserMutation } from '@/hooks/use-user-provision-mutation';
import { useUserProvisionConfig } from '@/hooks/use-user-provision-config';
import type { PasswordPolicy, ProvisionMode } from '@/api/user-provision';

interface CreateUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PolicyCheck {
  label: string;
  ok: boolean;
}

function checkPassword(pw: string, policy: PasswordPolicy): PolicyCheck[] {
  const checks: PolicyCheck[] = [
    { label: `Tối thiểu ${policy.minLength} ký tự`, ok: pw.length >= policy.minLength },
    { label: 'Dưới 70 ký tự', ok: pw.length > 0 && pw.length < 70 },
  ];
  if (policy.hasNumber) checks.push({ label: 'Có chữ số', ok: /\d/.test(pw) });
  if (policy.hasLowercase) checks.push({ label: 'Có chữ thường', ok: /[a-z]/.test(pw) });
  if (policy.hasUppercase) checks.push({ label: 'Có chữ hoa', ok: /[A-Z]/.test(pw) });
  if (policy.hasSymbol) checks.push({ label: 'Có ký tự đặc biệt', ok: /[^A-Za-z0-9]/.test(pw) });
  return checks;
}

export function CreateUserDialog({ open, onOpenChange }: CreateUserDialogProps) {
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [mode, setMode] = useState<ProvisionMode>('set_password');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');

  const { data: config, isLoading: configLoading } = useUserProvisionConfig();
  const mutation = useCreateUserMutation();

  const smtpEnabled = config?.smtp_enabled ?? false;
  const policy = config?.password_policy;

  const passwordChecks = useMemo(
    () => (policy ? checkPassword(password, policy) : []),
    [password, policy],
  );
  const passwordPolicyOk = passwordChecks.every((c) => c.ok);
  const passwordsMatch = password.length > 0 && password === passwordConfirm;

  const canSubmit =
    email.trim().length > 0 &&
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    (mode !== 'set_password' || (passwordPolicyOk && passwordsMatch));

  function reset() {
    setEmail('');
    setFirstName('');
    setLastName('');
    setMode('set_password');
    setPassword('');
    setPasswordConfirm('');
  }

  function handleOpenChange(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(
      {
        email: email.trim(),
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        mode,
        ...(mode === 'set_password' ? { password, password_change_required: true } : {}),
      },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
      },
    );
  }

  const modeDescription = {
    invite_email: smtpEnabled
      ? 'Zitadel gửi email chứa link xác thực + đặt mật khẩu tới user.'
      : 'Zitadel SMTP chưa được cấu hình cho INET — tạm thời không dùng được.',
    set_password: 'Admin đặt mật khẩu ban đầu. User sẽ bị buộc đổi mật khẩu ở lần đăng nhập đầu tiên.',
  } as const;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        title="Tạo người dùng mới"
        description="Central RBAC không lưu mật khẩu — mọi credential đều do Zitadel quản lý."
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ten@congty.com"
              required
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Họ *</label>
              <Input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Nguyễn"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tên *</label>
              <Input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="An"
                required
              />
            </div>
          </div>

          {/* Provision mode radio group */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-gray-700 mb-1">Cách kích hoạt</legend>

            <label
              className={`flex items-start gap-2 text-sm ${smtpEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
            >
              <input
                type="radio"
                name="mode"
                value="invite_email"
                checked={mode === 'invite_email'}
                onChange={() => setMode('invite_email')}
                disabled={!smtpEnabled}
                className="mt-1"
              />
              <div>
                <span className="font-medium text-gray-800">
                  Gửi email mời {!smtpEnabled && <span className="text-orange-600 text-xs font-normal">(cần SMTP)</span>}
                </span>
                <p className="text-xs text-gray-500">{modeDescription.invite_email}</p>
              </div>
            </label>

            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="mode"
                value="set_password"
                checked={mode === 'set_password'}
                onChange={() => setMode('set_password')}
                className="mt-1"
              />
              <div>
                <span className="font-medium text-gray-800">Đặt mật khẩu ngay</span>
                <p className="text-xs text-gray-500">{modeDescription.set_password}</p>
              </div>
            </label>
          </fieldset>

          {/* Password fields — only when set_password mode */}
          {mode === 'set_password' && (
            <div className="space-y-3 border-l-2 border-blue-100 pl-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mật khẩu *</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Xác nhận mật khẩu *</label>
                <Input
                  type="password"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
                {passwordConfirm.length > 0 && !passwordsMatch && (
                  <p className="text-xs text-red-600 mt-1">Mật khẩu xác nhận không khớp</p>
                )}
              </div>

              {policy && (
                <ul className="text-xs space-y-0.5">
                  {passwordChecks.map((c) => (
                    <li key={c.label} className={c.ok ? 'text-green-600' : 'text-red-500'}>
                      {c.ok ? '✓' : '✗'} {c.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={mutation.isPending}>
                Hủy
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!canSubmit || mutation.isPending || configLoading}>
              {mutation.isPending ? 'Đang tạo...' : 'Tạo người dùng'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
