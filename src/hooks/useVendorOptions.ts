import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/services/supabase';

export interface VendorOption {
  value: string;
  label: string;
}

export function useVendorOptions() {
  return useQuery({
    queryKey: ['vendor-options'],
    queryFn: async (): Promise<VendorOption[]> => {
      const { data, error } = await supabase
        .from('vendors')
        .select('name, active')
        .eq('active', true)
        .order('name', { ascending: true });

      if (error) throw error;

      const activeVendorNames = (data || [])
        .map((vendor) => vendor.name)
        .filter(Boolean);

      return activeVendorNames.map((value) => ({ value, label: value }));
    },
    staleTime: 5 * 60 * 1000,
  });
}
