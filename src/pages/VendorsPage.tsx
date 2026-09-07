import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Save } from 'lucide-react';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import Table from '@/components/ui/Table';
import FormSection from '@/components/ui/FormSection';
import { logAudit } from '@/services/audit';
import { showConfirm, showAlert } from '@/components/ui/GlobalDialog';

interface Vendor {
  id: string;
  name: string;
  code: string;
  active: boolean;
  created_by?: string;
  created_at?: string;
}

interface VendorContact {
  id: string;
  vendor_id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  is_primary: boolean;
}

interface POC {
  id: string | null;
  name: string;
  email: string;
  phone: string;
  role: string;
  is_primary: boolean;
  _new?: boolean;
  _del?: boolean;
}

export default function VendorsPage() {
  const queryClient = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);

  // Fetch vendors
  const { data: vendors = [], isLoading: vendorsLoading } = useQuery({
    queryKey: ['vendors'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('vendors')
        .select('*')
        .order('name', { ascending: true });

      if (error) throw error;
      return data as Vendor[];
    },
  });

  // Fetch all vendor contacts
  const { data: contacts = [], isLoading: contactsLoading } = useQuery({
    queryKey: ['vendor-contacts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('vendor_contacts')
        .select('*')
        .order('is_primary', { ascending: false });

      if (error) throw error;
      return data as VendorContact[];
    },
  });

  const isLoading = vendorsLoading || contactsLoading;

  const handleAddVendor = () => {
    setEditingVendor(null);
    setShowModal(true);
  };

  const handleEditVendor = (vendor: Vendor) => {
    setEditingVendor(vendor);
    setShowModal(true);
  };

  const deleteContactMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const { error } = await supabase
        .from('vendor_contacts')
        .delete()
        .eq('id', contactId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vendor-contacts'] });
    },
    onError: (error: any) => {
      console.error('Failed to remove contact: ' + error.message);
    },
  });

  const handleDeleteContact = async (contactId: string) => {
    const ok = await showConfirm('Remove this contact?', { danger: true });
    if (!ok) return;
    deleteContactMutation.mutate(contactId);
  };


  return (
    <div>
      {/* Header */}
      <div className="flex justify-end mb-4">
        <Button variant="primary" size="sm" onClick={handleAddVendor}>
          + Add Vendor
        </Button>
      </div>

      {/* Vendor List */}
      <Table
          data={vendors}
          isLoading={isLoading}
          emptyMessage="No vendors found. Click + Add Vendor to get started."
          columns={[
            {
              header: 'Vendor',
              accessor: (vendor) => (
                <div className="flex flex-col gap-1">
                  <div className="font-semibold text-text">{vendor.name}</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-surface2 text-text3">
                      {vendor.code}
                    </span>
                    <span
                      className={`text-[11px] font-semibold ${
                        vendor.active ? 'text-success' : 'text-danger'
                      }`}
                    >
                      {vendor.active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
              ),
            },
            {
              header: 'Contacts',
              accessor: (vendor) => {
                const vendorContacts = contacts.filter((c) => c.vendor_id === vendor.id);

                if (vendorContacts.length === 0) {
                  return <span className="text-text3">No contacts added yet</span>;
                }

                return (
                  <div className="space-y-2">
                    {vendorContacts.map((contact) => (
                      <div
                        key={contact.id}
                        className="rounded-md border border-border bg-surface2 px-3 py-2"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-text">{contact.name}</span>
                              {contact.is_primary && (
                                <span className="text-[10px] bg-accent text-white rounded px-1.5 py-0.5">
                                  Primary
                                </span>
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text2">
                              {contact.role && <span>{contact.role}</span>}
                              {contact.email && (
                                <a
                                  href={`mailto:${contact.email}`}
                                  className="hover:text-accent"
                                >
                                  {contact.email}
                                </a>
                              )}
                              {contact.phone && <span>{contact.phone}</span>}
                            </div>
                          </div>
                          <button
                            onClick={() => handleDeleteContact(contact.id)}
                            className="shrink-0 text-[11px] text-danger hover:underline px-1 py-0.5"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              },
            },
            {
              header: 'Actions',
              className: 'w-28',
              accessor: (vendor) => (
                <Button variant="ghost" size="sm" onClick={() => handleEditVendor(vendor)}>
                  Edit
                </Button>
              ),
            },
          ]}
        />

      {/* Add/Edit Modal */}
      {showModal && (
        <VendorModal
          vendor={editingVendor}
          existingContacts={
            editingVendor ? contacts.filter((c) => c.vendor_id === editingVendor.id) : []
          }
          onClose={() => setShowModal(false)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['vendors'] });
            queryClient.invalidateQueries({ queryKey: ['vendor-contacts'] });
            setShowModal(false);
          }}
        />
      )}
    </div>
  );
}

interface POCRowProps {
  poc: POC;
  index: number;
  onUpdate: (index: number, field: keyof POC, value: any) => void;
  onDelete: (index: number) => void;
  onSetPrimary: (index: number) => void;
}

function POCRow({ poc, index, onUpdate, onDelete, onSetPrimary }: POCRowProps) {
  const [emailError, setEmailError] = useState('');
  const [phoneError, setPhoneError] = useState('');

  return (
    <div
      className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-end p-3 bg-surface2 rounded-md"
    >
      {/* Name */}
      <div>
        <label className="block text-[10px] font-semibold text-text3 mb-1">Name *</label>
        <Input
          value={poc.name}
          onChange={(e) => onUpdate(index, 'name', e.target.value)}
          placeholder="Full name"
          size="sm"
        />
      </div>
      {/* Role */}
      <div>
        <label className="block text-[10px] font-semibold text-text3 mb-1">Role / Title</label>
        <Input
          value={poc.role}
          onChange={(e) => onUpdate(index, 'role', e.target.value)}
          placeholder="e.g. Account Manager"
          size="sm"
        />
      </div>
      {/* Email */}
      <div>
        <label className="block text-[10px] font-semibold text-text3 mb-1">Email</label>
        <Input
          type="email"
          value={poc.email}
          onChange={(e) => {
            onUpdate(index, 'email', e.target.value);
            setEmailError(e.target.value && !e.target.value.includes('@') ? 'Enter valid email' : '');
          }}
          placeholder="poc@company.com"
          size="sm"
        />
        {emailError && <div className="text-xs text-danger mt-1">{emailError}</div>}
      </div>
      {/* Phone */}
      <div>
        <label className="block text-[10px] font-semibold text-text3 mb-1">Phone</label>
        <Input
          type="tel"
          inputMode="numeric"
          maxLength={10}
          value={poc.phone}
          onChange={(e) => {
            const cleaned = e.target.value.replace(/\D/g, '');
            onUpdate(index, 'phone', cleaned);
            setPhoneError(cleaned.length > 0 && cleaned.length < 10 ? '10 digits required' : '');
          }}
          placeholder="10-digit number"
          size="sm"
        />
        {phoneError && <div className="text-xs text-danger mt-1">{phoneError}</div>}
      </div>
      {/* Primary & Delete */}
      <div className="flex flex-col gap-1 items-center">
        <label className="text-[10px] text-text3 whitespace-nowrap">Primary</label>
        <input
          type="checkbox"
          checked={poc.is_primary}
          onChange={(e) => { if (e.target.checked) onSetPrimary(index); }}
          className="accent-accent w-4 h-4 cursor-pointer"
        />
        <button
          type="button"
          onClick={() => onDelete(index)}
          className="text-danger hover:text-danger/80 px-1.5 py-0.5"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

interface VendorModalProps {
  vendor: Vendor | null;
  existingContacts: VendorContact[];
  onClose: () => void;
  onSuccess: () => void;
}

function VendorModal({
  vendor,
  existingContacts,
  onClose,
  onSuccess,
}: VendorModalProps) {
  const { user } = useAuthStore();
  const [name, setName] = useState(vendor?.name || '');
  const [code, setCode] = useState(vendor?.code || '');
  const [active, setActive] = useState(vendor?.active ?? true);
  const [pocs, setPocs] = useState<POC[]>(
    existingContacts.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      role: c.role,
      is_primary: c.is_primary,
      _new: false,
      _del: false,
    }))
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Validate basic fields
      if (!name.trim()) {
        showAlert('Name is required', { tone: 'error' });
        throw new Error('Validation failed');
      }
      if (!code.trim()) {
        showAlert('Code is required (used for Proctor IDs)', { tone: 'error' });
        throw new Error('Validation failed');
      }

      // Validate POCs
      const activePOCs = pocs.filter((p) => !p._del);
      for (const poc of activePOCs) {
        if (!poc.name.trim()) {
          showAlert('All POC entries must have a name', { tone: 'error' });
          throw new Error('Validation failed');
        }
        if (poc.email && !poc.email.includes('@')) {
          showAlert(`POC email "${poc.email}" is not valid — must include @`, { tone: 'error' });
          throw new Error('Validation failed');
        }
        if (poc.phone && !/^\d{10}$/.test(poc.phone)) {
          showAlert(`POC phone "${poc.phone}" must be exactly 10 digits`, { tone: 'error' });
          throw new Error('Validation failed');
        }
      }

      let vendorId = vendor?.id;

      // Save vendor
      if (vendorId) {
        const previousActive = vendor?.active ?? true;
        // Update existing
        const { error } = await supabase
          .from('vendors')
          .update({
            name: name.trim(),
            code: code.trim().toUpperCase(),
            active,
          })
          .eq('id', vendorId);

        if (error) throw error;

        if (previousActive !== active) {
          void logAudit({
            action: 'Vendor Status Changed',
            target: name.trim(),
            detail: `Status changed from ${previousActive ? 'Active' : 'Inactive'} to ${active ? 'Active' : 'Inactive'}`,
            user: user?.username || user?.email || 'unknown',
          });
        } else {
          void logAudit({
            action: 'Vendor Updated',
            target: name.trim(),
            detail: `Updated vendor entry${active ? ' · Active' : ' · Inactive'}`,
            user: user?.username || user?.email || 'unknown',
          });
        }
      } else {
        // Create new
        vendorId = crypto.randomUUID();
        const { error } = await supabase.from('vendors').insert({
          id: vendorId,
          name: name.trim(),
          code: code.trim().toUpperCase(),
          active,
          created_by: user?.username || user?.email || 'unknown',
        });

        if (error) throw error;

        void logAudit({
          action: 'Vendor Created',
          target: name.trim(),
          detail: `Created vendor ${code.trim().toUpperCase()} · ${active ? 'Active' : 'Inactive'}`,
          user: user?.username || user?.email || 'unknown',
        });
      }

      // Delete removed contacts
      const toDelete = pocs.filter((p) => p._del && p.id);
      for (const p of toDelete) {
        await supabase.from('vendor_contacts').delete().eq('id', p.id);
      }

      // Save active contacts
      for (const poc of activePOCs) {
        if (poc._new || !poc.id) {
          // Insert new
          await supabase.from('vendor_contacts').insert({
            id: crypto.randomUUID(),
            vendor_id: vendorId,
            name: poc.name.trim(),
            email: poc.email.trim(),
            phone: poc.phone.trim(),
            role: poc.role.trim(),
            is_primary: poc.is_primary,
          });
        } else {
          // Update existing
          await supabase
            .from('vendor_contacts')
            .update({
              name: poc.name.trim(),
              email: poc.email.trim(),
              phone: poc.phone.trim(),
              role: poc.role.trim(),
              is_primary: poc.is_primary,
            })
            .eq('id', poc.id);
        }
      }
    },
    onSuccess: () => {
      showAlert(vendor ? 'Updated successfully' : 'Added successfully', { tone: 'success' });
      onSuccess();
    },
    onError: (error: any) => {
      if (error.message !== 'Validation failed') {
        showAlert('Failed to save: ' + error.message, { tone: 'error' });
      }
    },
  });

  const addPOC = () => {
    const activePOCs = pocs.filter((p) => !p._del);
    setPocs([
      ...pocs,
      {
        id: null,
        name: '',
        email: '',
        phone: '',
        role: '',
        is_primary: activePOCs.length === 0,
        _new: true,
        _del: false,
      },
    ]);
  };

  const updatePOC = (index: number, field: keyof POC, value: any) => {
    const activePOCs = pocs.filter((p) => !p._del);
    const actualIndex = pocs.indexOf(activePOCs[index]);
    const newPOCs = [...pocs];
    newPOCs[actualIndex] = { ...newPOCs[actualIndex], [field]: value };
    setPocs(newPOCs);
  };

  const activePOCs = pocs.filter((p) => !p._del);

  const setPrimary = (index: number) => {
    const currentActivePOCs = pocs.filter((p) => !p._del);
    const newPOCs = pocs.map((p) => {
      const activeIdx = currentActivePOCs.indexOf(p);
      return {
        ...p,
        is_primary: activeIdx === index,
      };
    });
    setPocs(newPOCs);
  };

  const deletePOC = (index: number) => {
    const currentActivePOCs = pocs.filter((p) => !p._del);
    const actualIndex = pocs.indexOf(currentActivePOCs[index]);
    const newPOCs = [...pocs];
    newPOCs[actualIndex] = { ...newPOCs[actualIndex], _del: true };
    setPocs(newPOCs);
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={vendor ? 'Edit Vendor' : 'Add Vendor'}
      size="lg"
    >
      <div className="space-y-6">

        {/* Basic Info */}
        <FormSection title="Basic Info">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-text mb-1">
                Name <span className="text-danger">*</span>
              </label>
              <Input
                placeholder="e.g. Sai, TSN..."
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text mb-1">
                Code <span className="text-danger">*</span>
              </label>
              <Input
                placeholder="e.g. SAI"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                className="uppercase"
              />
              <div className="text-[11px] text-text3 mt-1">
                Short code used in Proctor IDs (e.g. SAI-0001)
              </div>
            </div>
          </div>
          <div className="mt-3">
            <label className="flex items-center gap-2 text-[13px] font-medium text-text cursor-pointer">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="accent-accent w-[15px] h-[15px]"
              />
              Active
            </label>
          </div>
        </FormSection>

        {/* Points of Contact */}
        <FormSection
          title="Points of Contact"
          action={
            <Button variant="ghost" size="sm" onClick={addPOC}>
              + Add POC
            </Button>
          }
        >

          {activePOCs.length === 0 ? (
            <div className="text-xs text-text3 py-2">
              No contacts yet — click + Add POC to add one.
            </div>
          ) : (
            <div className="space-y-2.5">
              {activePOCs.map((poc, index) => (
                <POCRow
                  key={index}
                  poc={poc}
                  index={index}
                  onUpdate={updatePOC}
                  onDelete={deletePOC}
                  onSetPrimary={setPrimary}
                />
              ))}
            </div>
          )}
        </FormSection>

        {/* Actions */}
        <div className="flex gap-2 justify-end pt-4 border-t border-border">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            <Save className="w-4 h-4" /> Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
