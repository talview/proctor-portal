import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/services/supabase';
import type { Proctor } from '@/types';

/**
 * Was independently defined (same filter, same order, near-identical columns) in both
 * IndividualAssessment and BulkAssessment under different query keys -- since the two
 * sub-tabs are mutually exclusive (only one mounts at a time), this wasn't a duplicate
 * fetch so much as switching between them re-fetching data already in cache under the
 * other key. One shared hook/query key fixes that.
 */
export function useAssessmentReadyProctors() {
  return useQuery({
    queryKey: ['assessment-ready-proctors'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('proctors')
        .select('id, name, email, vendor, ptype, assessment_ready, assessment_ready_attempt, at')
        .eq('assessment_ready', 'ready')
        .order('at', { ascending: false });

      if (error) throw error;
      return data as Proctor[];
    },
  });
}
