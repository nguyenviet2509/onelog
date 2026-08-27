/**
 * pages/users/user-detail-drawer.tsx — Right-side drawer showing user profile + grants.
 * Grant + Revoke actions rendered per-row. Mutations disabled when rbac_degraded.
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

interface UserDetailDrawerProps {
  userId: string | null;
  onClose: () => void;
}

export function UserDetailDrawer({ userId, onClose }: UserDetailDrawerProps) {
  const [grantOpen, setGrantOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Grant | null>(null);

  const { data: user, isLoading, error } = useUserDetailQuery(userId);
  const { canWrite } = usePermissions();

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
                  <div className="space-y-2">
                    {user.grants.map((grant) => (
                      <div
                        key={grant.id}
                        className="flex items-start justify-between gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5"
                      >
                        <div className="flex flex-col gap-1 min-w-0">
                          <span className="text-xs text-gray-400">{grant.project_name ?? grant.project_id}</span>
                          <div className="flex flex-wrap gap-1">
                            {grant.role_keys.map((rk) => (
                              <Badge key={rk} variant="default">{rk}</Badge>
                            ))}
                          </div>
                          {grant.granted_at && (
                            <span className="text-xs text-gray-400">
                              {new Date(grant.granted_at).toLocaleDateString('vi-VN')}
                              {grant.granted_by && ` · ${grant.granted_by}`}
                            </span>
                          )}
                        </div>

                        {canWrite() && (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setRevokeTarget(grant)}
                            className="shrink-0"
                          >
                            Thu hồi
                          </Button>
                        )}
                      </div>
                    ))}
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
              onOpenChange={(v) => { if (!v) setRevokeTarget(null); }}
              userId={user.id}
              userEmail={user.email}
              grantId={revokeTarget.id}
              roleKey={revokeTarget.role_keys[0]}
            />
          )}
        </>
      )}
    </>
  );
}
