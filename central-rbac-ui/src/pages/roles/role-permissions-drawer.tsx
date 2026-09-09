/**
 * pages/roles/role-permissions-drawer.tsx — Right-side drawer for editing role permissions.
 *
 * Features:
 *   - Fetches all permissions + current role permissions in parallel
 *   - Groups by module (qlts.assets.*, qlts.softwares.*, ...)
 *   - Collapsible sections per module with select-all toggle
 *   - Search box (client-side filter across key + description)
 *   - Diff old vs new on save → batch attach/detach via Promise.allSettled
 *   - Read-only mode for source='manifest' roles (banner + disabled checkboxes)
 */
import { useState, useEffect, useMemo } from 'react';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  useRoleDetailQuery,
  useRolePermissionsQuery,
  usePermissionsQuery,
  useRolePermissionsSaveMutation,
} from '@/hooks/use-roles-query';
import {
  groupPermissionsByModule,
  filterPermissionsByPrefix,
  searchPermissionGroups,
  type PermissionGroup,
} from './role-permissions-group-helper';

interface RolePermissionsDrawerProps {
  /** null = drawer closed */
  roleKey: string | null;
  onClose: () => void;
}

/** Collapsible group section with select-all. */
function PermissionGroupSection({
  group,
  selected,
  onChange,
  disabled,
}: {
  group: PermissionGroup;
  selected: Set<string>;
  onChange: (key: string, checked: boolean) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(true);
  const allChecked = group.permissions.every((p) => selected.has(p.key));
  const someChecked = group.permissions.some((p) => selected.has(p.key));

  function toggleAll() {
    if (allChecked) {
      group.permissions.forEach((p) => onChange(p.key, false));
    } else {
      group.permissions.forEach((p) => onChange(p.key, true));
    }
  }

  return (
    <div className="border border-gray-100 rounded-md overflow-hidden">
      {/* Group header */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-xs font-semibold text-gray-700 truncate">
            {group.module}
          </span>
          <Badge variant={someChecked ? 'default' : 'secondary'} className="text-xs shrink-0">
            {group.permissions.filter((p) => selected.has(p.key)).length}/{group.permissions.length}
          </Badge>
        </div>
        <span className="text-gray-400 text-xs ml-2 shrink-0">{open ? '▲' : '▼'}</span>
      </button>

      {/* Permission list */}
      {open && (
        <div className="px-3 py-2 space-y-1.5 bg-white">
          {/* Select-all row */}
          {!disabled && group.permissions.length > 1 && (
            <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-500 pb-1 border-b border-gray-50">
              <input
                type="checkbox"
                className="rounded border-gray-300"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = someChecked && !allChecked;
                }}
                onChange={toggleAll}
                aria-label={`Chọn tất cả ${group.module}`}
              />
              <span>Chọn tất cả ({group.permissions.length})</span>
            </label>
          )}

          {group.permissions.map((perm) => (
            <label
              key={perm.key}
              className={`flex items-start gap-2 ${disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
            >
              <input
                type="checkbox"
                className="rounded border-gray-300 mt-0.5 shrink-0"
                checked={selected.has(perm.key)}
                disabled={disabled}
                onChange={(e) => onChange(perm.key, e.target.checked)}
                aria-label={perm.key}
              />
              <div className="min-w-0">
                <span className="font-mono text-xs text-gray-800 break-all">{perm.key}</span>
                {perm.description && (
                  <p className="text-xs text-gray-400 mt-0.5">{perm.description}</p>
                )}
              </div>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function RolePermissionsDrawer({ roleKey, onClose }: RolePermissionsDrawerProps) {
  const [search, setSearch] = useState('');
  // Local checkbox state — initialised from server data when drawer opens
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Snapshot of server state for diff computation on save
  const [initialKeys, setInitialKeys] = useState<Set<string>>(new Set());
  const [hasInitialized, setHasInitialized] = useState(false);

  const { data: role, isLoading: roleLoading } = useRoleDetailQuery(roleKey);
  const { data: rolePermKeys = [], isLoading: permsLoading } = useRolePermissionsQuery(roleKey);
  const { data: allPerms = [], isLoading: allPermsLoading } = usePermissionsQuery();

  const saveMutation = useRolePermissionsSaveMutation(roleKey ?? '');

  const isReadOnly = role?.source === 'manifest';

  // Parse app prefix from role key: "qlts.approver" → "qlts:" (permission keys use colon separator per Central schema)
  const appPrefix = useMemo(() => {
    if (!role?.key) return undefined;
    const dot = role.key.indexOf('.');
    return dot > 0 ? `${role.key.slice(0, dot)}:` : undefined;
  }, [role?.key]);

  // All permissions filtered to this app's prefix, non-deprecated
  const appPerms = useMemo(
    () => filterPermissionsByPrefix(allPerms, appPrefix),
    [allPerms, appPrefix],
  );

  // Grouped by module
  const groups = useMemo(() => groupPermissionsByModule(appPerms), [appPerms]);

  // Search-filtered groups
  const visibleGroups = useMemo(
    () => searchPermissionGroups(groups, search),
    [groups, search],
  );

  // Initialise local selection from server data when both fetches complete
  useEffect(() => {
    if (!roleKey) {
      // Reset when drawer closes
      setSelected(new Set());
      setInitialKeys(new Set());
      setHasInitialized(false);
      setSearch('');
      return;
    }
    if (!permsLoading && !allPermsLoading && !hasInitialized) {
      const keySet = new Set(rolePermKeys);
      setSelected(new Set(keySet));
      setInitialKeys(new Set(keySet));
      setHasInitialized(true);
    }
  }, [roleKey, rolePermKeys, permsLoading, allPermsLoading, hasInitialized]);

  function handleCheckChange(key: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  const allAppSelected = appPerms.length > 0 && appPerms.every((p) => selected.has(p.key));
  const someAppSelected = appPerms.some((p) => selected.has(p.key));

  function toggleAllApp() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allAppSelected) {
        appPerms.forEach((p) => next.delete(p.key));
      } else {
        appPerms.forEach((p) => next.add(p.key));
      }
      return next;
    });
  }

  function handleSave() {
    saveMutation.mutate(
      { oldKeys: initialKeys, newKeys: selected },
      { onSuccess: () => onClose() },
    );
  }

  function handleOpenChange(open: boolean) {
    if (!open) onClose();
  }

  const isLoading = roleLoading || permsLoading || allPermsLoading;
  const isDirty = hasInitialized && (
    [...selected].some((k) => !initialKeys.has(k)) ||
    [...initialKeys].some((k) => !selected.has(k))
  );

  const drawerTitle = role
    ? `Permissions của ${role.key}`
    : roleKey
      ? `Permissions của ${roleKey}`
      : 'Permissions';

  return (
    <Drawer open={!!roleKey} onOpenChange={handleOpenChange} modal={false}>
      <DrawerContent title={drawerTitle} nonModal>
        {/* Manifest read-only banner */}
        {isReadOnly && (
          <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            <strong>Role này do manifest quản lý</strong> — sửa trong app manifest rồi sync lại. Không thể chỉnh sửa từ UI.
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="py-12 text-center text-sm text-gray-400">Đang tải permissions...</div>
        )}

        {/* Content */}
        {!isLoading && (
          <div className="flex flex-col gap-4">
            {/* Search */}
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm permission (vd: assets.read, create...)"
              aria-label="Tìm kiếm permission"
              className="w-full"
            />

            {/* Stats + select-all-app toggle */}
            <div className="flex items-center justify-between gap-3 text-xs text-gray-500">
              <div>
                {selected.size} / {appPerms.length} permissions được chọn
                {appPerms.length === 0 && appPrefix && (
                  <span className="ml-1 text-amber-600">
                    — Chưa có permission nào cho prefix <code>{appPrefix}</code>
                  </span>
                )}
              </div>
              {!isReadOnly && appPerms.length > 0 && (
                <label className="flex items-center gap-2 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300"
                    checked={allAppSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someAppSelected && !allAppSelected;
                    }}
                    onChange={toggleAllApp}
                    disabled={saveMutation.isPending}
                    aria-label="Chọn tất cả permissions của ứng dụng"
                  />
                  <span className="font-medium text-gray-700">
                    {allAppSelected ? 'Bỏ chọn tất cả' : `Chọn tất cả (${appPerms.length})`}
                  </span>
                </label>
              )}
            </div>

            {/* Groups */}
            {visibleGroups.length === 0 && search ? (
              <p className="text-sm text-gray-400 text-center py-4">
                Không tìm thấy permission phù hợp với &ldquo;{search}&rdquo;
              </p>
            ) : (
              <div className="space-y-2">
                {visibleGroups.map((group) => (
                  <PermissionGroupSection
                    key={group.module}
                    group={group}
                    selected={selected}
                    onChange={handleCheckChange}
                    disabled={isReadOnly || saveMutation.isPending}
                  />
                ))}
              </div>
            )}

            {/* Footer actions */}
            {!isReadOnly && (
              <div className="sticky bottom-0 bg-white pt-4 border-t border-gray-100 flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={onClose}
                  disabled={saveMutation.isPending}
                >
                  Hủy
                </Button>
                <Button
                  type="button"
                  onClick={handleSave}
                  disabled={!isDirty || saveMutation.isPending}
                >
                  {saveMutation.isPending ? 'Đang lưu...' : 'Lưu thay đổi'}
                </Button>
              </div>
            )}

            {isReadOnly && (
              <div className="sticky bottom-0 bg-white pt-4 border-t border-gray-100 flex justify-end">
                <Button type="button" variant="outline" onClick={onClose}>
                  Đóng
                </Button>
              </div>
            )}
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}
