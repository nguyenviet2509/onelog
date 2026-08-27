/**
 * pages/users/user-detail-drawer.tsx — Right-side drawer showing user profile + grants.
 *
 * Grant row = header (project name · org) + checkbox list of roles + 2 revoke buttons:
 *   - "Thu hồi đã chọn" (partial revoke of the checked role subset)
 *   - "Thu hồi toàn bộ" (drop the whole grant regardless of selection)
 * Both routes through the same RevokeDialog which sends role_keys to backend.
 */
import { useState } from 'react';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useUserDetailQuery } from '@/hooks/use-users-query';
import { usePermissions } from '@/hooks/use-permissions';
import { GrantDialog } from './grant-dialog';
import { RevokeDialog } from './revoke-dialog';
import type { Grant } from '@/lib/types';

interface RevokeTarget {
  grant: Grant;
  /** empty array → full grant DELETE; non-empty → partial revoke of listed keys. */
  roleKeys: string[];
}

interface UserDetailDrawerProps {
  userId: string | null;
  onClose: () => void;
}

export function UserDetailDrawer({ userId, onClose }: UserDetailDrawerProps) {
  const [grantOpen, setGrantOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  // Per-grant checkbox state: grantId → Set<roleKey>
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});

  const { data: user, isLoading, error } = useUserDetailQuery(userId);
  const { canWrite } = usePermissions();

  function toggleRole(grantId: string, roleKey: string): void {
    setSelected((prev) => {
      const cur = new Set(prev[grantId] ?? []);
      if (cur.has(roleKey)) cur.delete(roleKey);
      else cur.add(roleKey);
      return { ...prev, [grantId]: cur };
    });
  }

  function clearSelection(grantId: string): void {
    setSelected((prev) => {
      const next = { ...prev };
      delete next[grantId];
      return next;
    });
  }

  const isOpen = !!userId;

  function handleOpenChange(open: boolean) {
    if (!open) onClose();
  }

  return (
    <>
      <Drawer open={isOpen} onOpenChange={handleOpenChange}>
        <DrawerContent title={user?.display_name ?? 'Chi tiết người dùng'}>
          {isLoading && (
            <div className="text-sm text-gray-400 py-8 text-center">Đang tải...</div>
          )}

          {error && (
            <div className="text-sm text-red-500 py-4">
              Không thể tải thông tin người dùng.
            </div>
          )}

          {user && (
            <div className="space-y-6">
              {/* Profile section */}
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-semibold text-lg shrink-0">
                  {user.display_name?.[0]?.toUpperCase() ?? '?'}
                </div>
                <div>
                  <p className="font-medium text-gray-900">{user.display_name}</p>
                  <p className="text-sm text-gray-500">{user.email}</p>
                  {user.organization?.name && (
                    <p className="text-xs text-gray-500 mt-1 inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                      Tổ chức: <span className="font-medium">{user.organization.name}</span>
                    </p>
                  )}
                </div>
              </div>

              {/* Grants section */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-700">Quyền hiện tại</h3>
                  {canWrite() && (
                    <Button size="sm" onClick={() => setGrantOpen(true)}>
                      + Cấp quyền
                    </Button>
                  )}
                </div>

                {(user.grants ?? []).length === 0 ? (
                  <p className="text-sm text-gray-400">Chưa có quyền nào được cấp.</p>
                ) : (
                  <div className="space-y-3">
                    {user.grants.map((grant) => {
                      const selectedForGrant = selected[grant.id] ?? new Set<string>();
                      const hasSelection = selectedForGrant.size > 0;
                      return (
                        <div
                          key={grant.id}
                          className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 space-y-2"
                        >
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span className="text-sm font-medium text-gray-800">
                              {grant.project_name ?? grant.project_id}
                            </span>
                            {grant.org_name && (
                              <span className="text-xs text-gray-500">Tổ chức: {grant.org_name}</span>
                            )}
                          </div>

                          <div className="flex flex-col gap-1.5">
                            {grant.role_keys.map((rk) => (
                              <label
                                key={rk}
                                className="flex items-center gap-2 cursor-pointer text-sm text-gray-700"
                              >
                                {canWrite() && (
                                  <input
                                    type="checkbox"
                                    className="rounded border-gray-300"
                                    checked={selectedForGrant.has(rk)}
                                    onChange={() => toggleRole(grant.id, rk)}
                                    aria-label={`Chọn ${rk}`}
                                  />
                                )}
                                <Badge variant="default">{rk}</Badge>
                              </label>
                            ))}
                          </div>

                          {canWrite() && (
                            <div className="flex flex-wrap gap-2 pt-1">
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={!hasSelection}
                                onClick={() =>
                                  setRevokeTarget({
                                    grant,
                                    roleKeys: Array.from(selectedForGrant),
                                  })
                                }
                              >
                                Thu hồi đã chọn ({selectedForGrant.size})
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  setRevokeTarget({ grant, roleKeys: [] })
                                }
                              >
                                Thu hồi toàn bộ
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </DrawerContent>
      </Drawer>

      {user && (
        <>
          <GrantDialog
            open={grantOpen}
            onOpenChange={setGrantOpen}
            userId={user.id}
            userEmail={user.email}
          />
          {revokeTarget && (
            <RevokeDialog
              open={!!revokeTarget}
              onOpenChange={(v) => {
                if (!v) {
                  clearSelection(revokeTarget.grant.id);
                  setRevokeTarget(null);
                }
              }}
              userId={user.id}
              userEmail={user.email}
              grantId={revokeTarget.grant.id}
              roleKeys={revokeTarget.roleKeys}
              projectLabel={revokeTarget.grant.project_name ?? revokeTarget.grant.project_id}
            />
          )}
        </>
      )}
    </>
  );
}
