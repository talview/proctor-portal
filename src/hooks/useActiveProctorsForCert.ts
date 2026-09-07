import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/services/supabase';
import type { Proctor } from '@/types';

/**
 * Active, PID-assigned proctors -- the eligible pool for certifying against a
 * customer. Was independently defined (same queryKey, same query) in both
 * IndividualCertify and BulkCertify; sharing one hook means editing this query
 * once instead of twice staying in sync by convention.
 */
export function useActiveProctorsForCert() {
  return useQuery({
    queryKey: ['active-proctors-for-cert'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('proctors')
        .select('*')
        .eq('status', 'Active')
        .not('pid', 'is', null)
        .order('name', { ascending: true });

      if (error) throw error;
      return data as Proctor[];
    },
  });
}
