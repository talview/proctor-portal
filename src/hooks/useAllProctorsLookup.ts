import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/services/supabase';
import type { Proctor } from '@/types';

/**
 * A by-id lookup map fetch, not a list -- both WorkspacePage tabs join task/
 * evaluation rows against proctor name/vendor/type via `.find(p => p.id ===
 * ...)`, so this can't be paginated the way a rendered list could (every page
 * of tasks still needs the full lookup). Was independently defined (same
 * queryKey, same query) in both UpcomingTasksTab and ScheduledEventsTab; this
 * also narrows it from select('*') to just the fields either tab reads.
 */
export function useAllProctorsLookup() {
  return useQuery({
    queryKey: ['all-proctors'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('proctors')
        .select('id, name, email, managed_by, vendor, ptype');
      if (error) throw error;
      return data as Proctor[];
    },
  });
}
