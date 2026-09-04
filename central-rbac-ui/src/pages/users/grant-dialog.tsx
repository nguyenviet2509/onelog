/**
 * pages/users/grant-dialog.tsx — Dialog to assign a role to a user.
 *
 * Post-Migration 012 rewrite: Project select drives Role list (filter by app_id).
 * Options show "ProjectName · OrgName" so admin sees cross-org context.
 * Submit disabled until both fields chosen. Role picks include legacy roles
 * (app_id NULL) when no project selected — surfaced as "Legacy / global".
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { listRoles } from '@/api/roles';
import { listProjects } from '@/api/projects';
import { useGrantMutation } from '@/hooks/use-assignments-query';

interface GrantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userEmail: string;
}

export function GrantDialog({ open, onOpenChange, userId, userEmail }: GrantDialogProps) {
  const [selectedProject, setSelectedProject] = useState('');
  const [selectedRole, setSelectedRole] = useState('');

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
    staleTime: 5 * 60_000,
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: listRoles,
    staleTime: 5 * 60_000,
  });

  const grant = useGrantMutation(userId, userEmail);

  const selectedProjectObj = useMemo(
    () => projects.find((p) => p.id === selectedProject),
    [projects, selectedProject],
  );
  const selectedProjectApp = selectedProjectObj?.app_id ?? '';
  const selectedIsUnregistered =
    !!selectedProjectObj && !selectedProjectObj.app_id && selectedProject !== 'legacy';

  // Filter roles by selected project's app_id. Roles without app_id (legacy)
  // stay visible only when the "Legacy / global" project option is selected.
  const filteredRoles = useMemo(() => {
    if (!selectedProject) return [];
    if (selectedProject === 'legacy') return roles.filter((r) => !r.app_id);
    return roles.filter((r) => r.app_id === selectedProjectApp);
  }, [roles, selectedProject, selectedProjectApp]);

  // Reset role when project changes to avoid stale mismatched role.
  useEffect(() => {
    setSelectedRole('');
  }, [selectedProject]);

  const legacyRolesCount = roles.filter((r) => !r.app_id).length;

  function handleSubmit() {
    if (!selectedRole) return;
    grant.mutate(
      { role_key: selectedRole },
      { onSuccess: () => { onOpenChange(false); setSelectedRole(''); setSelectedProject(''); } },
    );
  }

  function handleOpenChange(v: boolean) {
    if (!v) { setSelectedRole(''); setSelectedProject(''); }
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent title="Cấp quyền" description={`Cấp quyền cho: ${userEmail}`}>
        <div className="space-y-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Dự án</label>
            <Select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
            >
              <option value="">-- Chọn dự án --</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.org?.name ? ` · ${p.org.name}` : ''}
                  {p.app_id ? '' : ' (chưa đăng ký)'}
                </option>
              ))}
              {legacyRolesCount > 0 && (
                <option value="legacy">Legacy / global ({legacyRolesCount} vai trò)</option>
              )}
            </Select>
            {selectedIsUnregistered && (
              <p className="text-xs text-orange-600 mt-1">
                Dự án này chưa được đăng ký với Central RBAC — chưa có role nội bộ để cấp.
                Vào <strong>Ứng dụng → + App mới</strong> để đăng ký (hoặc dùng Zitadel Console để cấp trực tiếp).
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vai trò</label>
            <Select
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value)}
              disabled={!selectedProject || filteredRoles.length === 0}
            >
              <option value="">
                {selectedProject
                  ? filteredRoles.length === 0
                    ? '-- Không có vai trò cho dự án này --'
                    : '-- Chọn vai trò --'
                  : '-- Chọn dự án trước --'}
              </option>
              {filteredRoles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.display_name} ({r.key})
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <DialogClose asChild>
            <Button variant="outline" disabled={grant.isPending}>Hủy</Button>
          </DialogClose>
          <Button
            onClick={handleSubmit}
            disabled={!selectedProject || !selectedRole || grant.isPending}
          >
            {grant.isPending ? 'Đang cấp...' : 'Cấp quyền'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
