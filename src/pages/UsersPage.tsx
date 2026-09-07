import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, Key } from 'lucide-react';
import { supabase, invokeEdgeFunction } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import Table from '@/components/ui/Table';
import { showAlert, showConfirm } from '@/components/ui/GlobalDialog';

interface Profile {
  id: string;
  username: string;
  email: string;
  role: string;
  vendor_id: string | null;
  vendors: { name: string } | null;
}

export default function UsersPage() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ['user-profiles'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('users')
        .select('id, username, email, role, vendor_id, vendors(name)')
        .order('email', { ascending: true });

      if (error) throw error;
      return data as unknown as Profile[];
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (userId: string) => {
      await invokeEdgeFunction('delete-user', { userId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-profiles'] });
    },
    onError: (err: any) => {
      showAlert('Failed to delete user: ' + err.message, { tone: 'error' });
    },
  });

  const handleDelete = async (profile: Profile) => {
    if (profile.id === user?.id) {
      showAlert('You cannot delete your own account.', { tone: 'error' });
      return;
    }
    const ok = await showConfirm(`Delete ${profile.email}? This cannot be undone.`, { danger: true });
    if (ok) {
      deleteMutation.mutate(profile.id);
    }
  };

  return (
    <div>
      <div className="flex justify-end mb-4">
        <Button variant="primary" size="sm" onClick={() => setShowModal(true)}>
          + Create User
        </Button>
      </div>

      <Table
        data={profiles}
        isLoading={isLoading}
        emptyMessage="No users yet. Click + Create User to add one."
        columns={[
          {
            header: 'Email',
            accessor: (row) => (
              <div>
                <div className="font-semibold text-text">{row.email || '—'}</div>
                <div className="text-[11px] text-text3">{row.username}</div>
              </div>
            ),
          },
          {
            header: 'Role',
            accessor: (row) => (
              <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-info/10 text-info capitalize">
                {row.role}
              </span>
            ),
          },
          {
            header: 'Vendor',
            accessor: (row) => row.vendors?.name || <span className="text-text3">—</span>,
          },
          {
            header: 'Actions',
            accessor: (row) => (
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditingProfile(row)}>
                  Change Role
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => handleDelete(row)}
                  disabled={deleteMutation.isPending}
                >
                  Delete
                </Button>
              </div>
            ),
          },
        ]}
      />

      {showModal && (
        <InviteUserModal
          onClose={() => setShowModal(false)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['user-profiles'] });
          }}
        />
      )}

      {editingProfile && (
        <ChangeRoleModal
          profile={editingProfile}
          onClose={() => setEditingProfile(null)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['user-profiles'] });
            setEditingProfile(null);
          }}
        />
      )}
    </div>
  );
}

interface VendorOption {
  id: string;
  name: string;
}

function InviteUserModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [mode, setMode] = useState<'invite' | 'password'>('invite');
  const [result, setResult] = useState<{ password?: string } | null>(null);

  const { data: vendors = [] } = useQuery({
    queryKey: ['vendors-for-invite'],
    queryFn: async () => {
      const { data, error } = await supabase.from('vendors').select('id, name').order('name');
      if (error) throw error;
      return data as VendorOption[];
    },
  });

  const inviteMutation = useMutation({
    mutationFn: async () => {
      if (!email || !email.includes('@')) throw new Error('Enter a valid email');
      if (!role) throw new Error('Select a role');
      if (role === 'vendor' && !vendorId) throw new Error('Select a vendor');

      return invokeEdgeFunction<{ success: boolean; password?: string }>('invite-user', {
        email: email.trim(), role, vendorId: role === 'vendor' ? vendorId : undefined, mode,
      });
    },
    onSuccess: (data) => {
      setResult({ password: data.password });
      onSuccess();
    },
    onError: (err: any) => {
      showAlert(err.message || 'Failed to create user', { tone: 'error' });
    },
  });

  if (result) {
    return (
      <Modal isOpen={true} onClose={onClose} title="User created">
        <div className="space-y-4">
          <div className="bg-success/10 border border-success/30 rounded-lg p-3 text-success text-sm">
            {mode === 'invite'
              ? `An invite email was sent to ${email}.`
              : `Account created for ${email}.`}
          </div>
          {result.password && (
            <div className="bg-warning/10 border border-warning/30 rounded-lg p-3">
              <div className="text-xs font-semibold text-text mb-1">Temporary password (shown once)</div>
              <div className="font-mono text-sm text-text select-all">{result.password}</div>
              <div className="text-[11px] text-text3 mt-2">Share this with the user directly — it will not be shown again.</div>
            </div>
          )}
          <div className="flex justify-end pt-2 border-t border-border">
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={true} onClose={onClose} title="Create User">
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-text mb-1">Email <span className="text-danger">*</span></label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
        </div>

        <div>
          <label className="block text-xs font-semibold text-text mb-1">Role <span className="text-danger">*</span></label>
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            options={[
              { value: '', label: 'Select role...' },
              { value: 'admin', label: 'Admin' },
              { value: 'coordinator', label: 'Coordinator' },
              { value: 'vendor', label: 'Vendor' },
            ]}
          />
        </div>

        {role === 'vendor' && (
          <div>
            <label className="block text-xs font-semibold text-text mb-1">Vendor <span className="text-danger">*</span></label>
            <Select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              options={[
                { value: '', label: 'Select vendor...' },
                ...vendors.map((v) => ({ value: v.id, label: v.name })),
              ]}
            />
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-text mb-1">How should they get access?</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode('invite')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold border ${mode === 'invite' ? 'bg-accent text-white border-accent' : 'border-border text-text2'}`}
            >
              <Mail className="w-3.5 h-3.5" /> Email invite
            </button>
            <button
              type="button"
              onClick={() => setMode('password')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold border ${mode === 'password' ? 'bg-accent text-white border-accent' : 'border-border text-text2'}`}
            >
              <Key className="w-3.5 h-3.5" /> Set password directly
            </button>
          </div>
          {mode === 'invite' && (
            <div className="text-[11px] text-text3 mt-1">
              Sends an invite email via Mailgun with a link to accept and set a password.
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end pt-4 border-t border-border">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => inviteMutation.mutate()} disabled={inviteMutation.isPending}>
            {inviteMutation.isPending ? 'Creating...' : 'Create User'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ChangeRoleModal({ profile, onClose, onSuccess }: { profile: Profile; onClose: () => void; onSuccess: () => void }) {
  const [role, setRole] = useState(profile.role);
  const [vendorId, setVendorId] = useState(profile.vendor_id || '');

  const { data: vendors = [] } = useQuery({
    queryKey: ['vendors-for-invite'],
    queryFn: async () => {
      const { data, error } = await supabase.from('vendors').select('id, name').order('name');
      if (error) throw error;
      return data as VendorOption[];
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!role) throw new Error('Select a role');
      if (role === 'vendor' && !vendorId) throw new Error('Select a vendor');

      const { error } = await supabase
        .from('users')
        .update({ role, vendor_id: role === 'vendor' ? vendorId : null })
        .eq('id', profile.id);

      if (error) throw error;
    },
    onSuccess: () => {
      showAlert('Role updated', { tone: 'success' });
      onSuccess();
    },
    onError: (err: any) => {
      showAlert(err.message || 'Failed to update user', { tone: 'error' });
    },
  });

  return (
    <Modal isOpen={true} onClose={onClose} title={`Change Role — ${profile.email}`}>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-text mb-1">Role <span className="text-danger">*</span></label>
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            options={[
              { value: 'admin', label: 'Admin' },
              { value: 'coordinator', label: 'Coordinator' },
              { value: 'vendor', label: 'Vendor' },
            ]}
          />
        </div>

        {role === 'vendor' && (
          <div>
            <label className="block text-xs font-semibold text-text mb-1">Vendor <span className="text-danger">*</span></label>
            <Select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              options={[
                { value: '', label: 'Select vendor...' },
                ...vendors.map((v) => ({ value: v.id, label: v.name })),
              ]}
            />
          </div>
        )}

        <div className="flex gap-2 justify-end pt-4 border-t border-border">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
