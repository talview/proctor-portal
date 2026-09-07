import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, ExternalLink } from 'lucide-react';
import { supabase, invokeEdgeFunction } from '@/services/supabase';
import Select from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import { showAlert } from '@/components/ui/GlobalDialog';
import LoadingSpinner from '@/components/ui/LoadingSpinner';

type FieldKind = 'signature' | 'date' | 'full_name' | 'text';
type ExpiryPolicy = '24h' | 'same_day';

const EXPIRY_POLICY_OPTIONS: { value: ExpiryPolicy; label: string }[] = [
  { value: '24h', label: '24 hours from when the link is sent' },
  { value: 'same_day', label: 'Same day only (deadline 11:59 PM IST that day)' },
];

interface MappedField {
  field_key: string;
  kind: FieldKind;
  label?: string;
  page_index: number;
}

const KIND_LABELS: Record<FieldKind, string> = {
  signature: 'Signature',
  date: 'Date',
  full_name: 'Full Name',
  text: 'Text',
};

// Read-only by design: the onboarding document PDF and its field positions are set up
// directly against the source file rather than through a click-and-drag admin UI --
// this page exists purely so admins can confirm what's currently live. Admin-only
// access is enforced by RoleGate at the route level (see App.tsx), not here.
export default function NdaTemplatePage() {
  return <ActiveTemplateView />;
}

function ActiveTemplateView() {
  const queryClient = useQueryClient();
  const [pendingPolicy, setPendingPolicy] = useState<ExpiryPolicy | null>(null);

  const { data: template, isLoading } = useQuery({
    queryKey: ['nda-active-template'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('nda_templates')
        .select('id, version, label, storage_bucket, storage_path, page_count, field_map, published_by, published_at, expiry_policy')
        .eq('is_active', true)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const setExpiryPolicyMutation = useMutation({
    mutationFn: async (expiryPolicy: ExpiryPolicy) => {
      return invokeEdgeFunction('nda-template-set-expiry-policy', { expiryPolicy });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nda-active-template'] });
      setPendingPolicy(null);
    },
    onError: (err: any) => {
      showAlert(err.message || 'Could not update the expiry policy');
      setPendingPolicy(null);
    },
  });

  const { data: previewUrl } = useQuery({
    queryKey: ['nda-active-template-preview', template?.storage_path],
    enabled: !!template?.storage_path,
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from(template!.storage_bucket)
        .createSignedUrl(template!.storage_path, 600);
      if (error) throw error;
      return data.signedUrl;
    },
  });

  const fieldCounts = ((template?.field_map || []) as MappedField[]).reduce<Record<string, number>>((acc, f) => {
    acc[f.kind] = (acc[f.kind] || 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <div className="bg-surface border border-border rounded-lg p-4 mb-4">
        <h3 className="text-sm font-semibold text-text mb-1">Active Onboarding Document</h3>
        {isLoading ? (
          <div className="flex items-center gap-2">
            <LoadingSpinner size="sm" />
            <p className="text-xs text-text3">Loading...</p>
          </div>
        ) : template ? (
          <p className="text-xs text-text2">
            v{template.version} &middot; {template.label} &middot; {template.page_count} page(s) &middot; published{' '}
            {new Date(template.published_at).toLocaleDateString()} by {template.published_by}
          </p>
        ) : (
          <p className="text-xs text-warning">No active document yet &mdash; "Send Onboarding Docs" will fail until one is published.</p>
        )}
      </div>

      {template && (
        <div className="bg-surface border border-border rounded-lg p-4 mb-4">
          <h3 className="text-sm font-semibold text-text mb-1">Signing link expiry</h3>
          <p className="text-xs text-text3 mb-3">Applies to every new "Send Onboarding Docs" link going forward. Sessions already sent keep the deadline they were created with.</p>
          <div className="flex items-end gap-3">
            <Select
              wrapperClassName="w-auto min-w-[320px]"
              options={EXPIRY_POLICY_OPTIONS}
              value={pendingPolicy ?? template.expiry_policy}
              onChange={(e) => setPendingPolicy(e.target.value as ExpiryPolicy)}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={pendingPolicy === null || pendingPolicy === template.expiry_policy || setExpiryPolicyMutation.isPending}
              onClick={() => pendingPolicy && setExpiryPolicyMutation.mutate(pendingPolicy)}
            >
              {setExpiryPolicyMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      )}

      {template && (
        <div className="bg-surface border border-border rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-text">
              <FileText className="w-4 h-4" />
              <span className="text-sm font-semibold">{template.label}</span>
            </div>
            {previewUrl && (
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline"
              >
                Preview PDF <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {(['signature', 'date', 'full_name', 'text'] as FieldKind[]).map((kind) => (
              <div key={kind} className="bg-surface2 border border-border rounded-lg px-3 py-2 text-center">
                <div className="text-lg font-bold text-text">{fieldCounts[kind] || 0}</div>
                <div className="text-[11px] text-text3">{KIND_LABELS[kind]}</div>
              </div>
            ))}
          </div>

          <h4 className="text-xs font-semibold text-text uppercase tracking-wide mb-2">
            Mapped fields ({(template.field_map as MappedField[]).length})
          </h4>
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {(template.field_map as MappedField[]).map((f) => (
              <div
                key={f.field_key}
                className="flex items-center justify-between px-3 py-1.5 bg-surface2 border border-border rounded text-xs"
              >
                <span className="text-text2">
                  <span className="font-semibold text-text">{f.field_key}</span> &middot; page {f.page_index + 1} &middot;{' '}
                  {KIND_LABELS[f.kind]}
                  {f.label ? ` ("${f.label}")` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
