/**
 * pages/users/grant-dialog.tsx — Dialog to assign a role to a user.
 * Project select + role select → POST /v1/assignments
 */
import { useState } from 'react';
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
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vai trò</label>
            <Select
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value)}
              disabled={roles.length === 0}
            >
              <option value="">-- Chọn vai trò --</option>
              {roles.map((r) => (
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
            disabled={!selectedRole || grant.isPending}
          >
            {grant.isPending ? 'Đang cấp...' : 'Cấp quyền'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
