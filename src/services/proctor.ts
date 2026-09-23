import { supabase } from './supabase';
import type { Proctor, ProctorFilters } from '@/types';
import { PROCTOR_SEARCH_COLUMNS } from '@/utils/constants';
import { orIlikeFilter } from '@/utils/postgrest';
import { EXPORT_ROW_CAP } from '@/lib/csv';

export const proctorService = {
  /**
   * Get all proctors matching the given filters, for export -- this is this
   * service's only caller (ProctorsPage's export button), so the
   * EXPORT_ROW_CAP applies unconditionally rather than as an opt-in.
   */
  async getAll(filters?: ProctorFilters): Promise<{ rows: Proctor[]; truncated: boolean }> {
    let query = supabase
      .from('proctors')
      .select('*')
      .neq('status', 'Archived') // Archived rows are re-onboarding history, surfaced only on the Offboarded & History page
      .neq('interview_stage', 'interview_selected') // pre-form-submission candidates belong only on the Interview Selects page
      .order('at', { ascending: false }); // Use 'at' not 'created_at'

    if (filters?.vendor) {
      query = query.eq('vendor', filters.vendor);
    }

    if (filters?.status) {
      query = query.eq('status', filters.status);
    }

    if (filters?.ptype) {
      query = query.eq('ptype', filters.ptype);
    }

    // Server-side search, over PROCTOR_SEARCH_COLUMNS -- the same constant
    // ProctorsPage's paginated table uses, so the two can't drift apart again the
    // way they did before (this used to be a separate client-side .filter() that
    // still matched on phone after that was deliberately dropped from the table's
    // search, so export could return a different set of rows than what's on screen
    // for the same search term).
    const search = filters?.search?.trim();
    if (search) {
      query = query.or(orIlikeFilter(PROCTOR_SEARCH_COLUMNS, search));
    }

    const { data, error } = await query.range(0, EXPORT_ROW_CAP);

    if (error) {
      throw new Error(error.message);
    }

    const rows = (data ?? []) as Proctor[];
    return { rows: rows.slice(0, EXPORT_ROW_CAP), truncated: rows.length > EXPORT_ROW_CAP };
  },

  /**
   * Get a single proctor by ID
   */
  async getById(id: string): Promise<Proctor | null> {
    const { data, error } = await supabase
      .from('proctors')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return data as Proctor;
  },

  /**
   * Create a new proctor
   */
  async create(proctor: Partial<Proctor>): Promise<Proctor> {
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from('proctors')
      .insert({
        ...proctor,
        status: 'In Progress',
        at: now, // Database uses 'at' not 'created_at'
        upd: now, // Database uses 'upd' not 'updated_at'
      })
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return data as Proctor;
  },

  /**
   * Update a proctor
   */
  async update(id: string, updates: Partial<Proctor>): Promise<Proctor> {
    const { data, error } = await supabase
      .from('proctors')
      .update({
        ...updates,
        upd: new Date().toISOString(), // Database uses 'upd' not 'updated_at'
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return data as Proctor;
  },

  /**
   * Delete a proctor
   */
  async delete(id: string): Promise<void> {
    const { error } = await supabase
      .from('proctors')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(error.message);
    }
  },

  /**
   * Bulk create proctors
   */
  async bulkCreate(proctors: Partial<Proctor>[]): Promise<Proctor[]> {
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from('proctors')
      .insert(
        proctors.map((p) => ({
          ...p,
          status: 'In Progress',
          at: now, // Database uses 'at' not 'created_at'
          upd: now, // Database uses 'upd' not 'updated_at'
        }))
      )
      .select();

    if (error) {
      throw new Error(error.message);
    }

    return data as Proctor[];
  },

  /**
   * Get dashboard statistics
   */
  async getStats(vendor?: string) {
    // Computed server-side via get_proctor_stats -- a single Postgres aggregate
    // query (count(*) filter, group by vendor), not a fetch-every-row-then-count-
    // in-JS pass. The function itself re-scopes a vendor-role caller to their own
    // vendor regardless of what's passed here, so this is purely which vendor the
    // *current* admin/coordinator view wants to look at, not an access boundary.
    const { data, error } = await supabase.rpc('get_proctor_stats', {
      p_vendor: vendor ?? null,
    });

    if (error) {
      throw new Error(error.message);
    }

    return data as {
      total: number;
      inProgress: number;
      verified: number;
      active: number;
      offboarded: number;
      interviewSelects: number;
      bgvMissing: number;
      bgvOverdue: number;
      demoCert: number;
      assessCert: number;
      byVendor: Record<string, {
        total: number;
        inProgress: number;
        active: number;
        bgvMissing: number;
        bgvOverdue: number;
        demoCert: number;
        assessCert: number;
      }>;
    };
  },

  /**
   * Upload file to Supabase storage
   */
  /**
   * Uploads a file and returns its storage path (not a public URL) -- the bucket
   * is private, so viewing it later means minting a short-lived signed URL at
   * view time, the same pattern the nda-signing bucket already uses.
   */
  async uploadFile(
    bucket: string,
    path: string,
    file: File
  ): Promise<string> {
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(path, file, {
        upsert: true,
      });

    if (error) {
      throw new Error(error.message);
    }

    return data.path;
  },
};
