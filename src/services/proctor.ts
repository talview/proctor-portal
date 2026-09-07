import { supabase } from './supabase';
import type { Proctor, ProctorFilters } from '@/types';

export const proctorService = {
  /**
   * Get all proctors with optional filters
   */
  async getAll(filters?: ProctorFilters): Promise<Proctor[]> {
    let query = supabase
      .from('proctors')
      .select('*')
      .neq('status', 'Archived') // Archived rows are re-onboarding history, surfaced only on the Offboarded & History page
      .neq('interview_stage', 'interview_selected') // pre-form-submission candidates belong only on the Interview Selects page
      .order('at', { ascending: false }); // Use 'at' not 'created_at'

    if (filters?.vendor) {
      query = query.eq('managed_by', filters.vendor);
    }

    if (filters?.status) {
      query = query.eq('status', filters.status);
    }

    if (filters?.ptype) {
      query = query.eq('ptype', filters.ptype);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(error.message);
    }

    let result = data as Proctor[];

    // Client-side search filter
    if (filters?.search) {
      const search = filters.search.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(search) ||
          p.email?.toLowerCase().includes(search) ||
          p.phone?.includes(search) ||
          p.pid?.toLowerCase().includes(search)
      );
    }

    return result;
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
    // Fetch all required fields (using correct database column names)
    let query = supabase.from('proctors').select('status, managed_by, interview_stage, bgv, demo_ready, assessment_ready, at, upd, vendor');

    if (vendor) {
      query = query.or(`vendor.eq."${vendor}",managed_by.eq."${vendor}"`);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(error.message);
    }

    const allProctors = data as Proctor[];
    
    // Map vendor field (fallback to managed_by if vendor doesn't exist)
    allProctors.forEach(p => {
      if (!p.vendor && p.managed_by) {
        p.vendor = p.managed_by;
      }
    });
    
    // Exclude interview_selected and Archived proctors from main stats (like HTML app)
    const activeProctors = allProctors.filter(
      p => p.status !== 'Archived' && p.interview_stage !== 'interview_selected'
    );
    
    // Count interview selects separately
    const interviewSelects = allProctors.filter(p => p.interview_stage === 'interview_selected').length;
    
    // BGV statistics -- only collectible once a proctor is Active, and the due window
    // (12 days, matching IncompletePage) counts from activation (aat), not creation.
    const BGV_DUE_DAYS = 12;
    const bgvMissing = activeProctors.filter(p => p.status === 'Active' && !p.bgv);
    const bgvOverdue = bgvMissing.filter(p => {
      if (!p.aat) return false;
      const activatedDate = new Date(p.aat);
      const daysSinceActivated = Math.floor((Date.now() - activatedDate.getTime()) / (1000 * 60 * 60 * 24));
      return daysSinceActivated > BGV_DUE_DAYS;
    }).length;
    
    // Certification statistics
    const demoCert = activeProctors.filter(p => p.demo_ready === 'pass').length;
    const assessCert = activeProctors.filter(p => p.assessment_ready === 'pass').length;

    const stats = {
      total: activeProctors.length,
      inProgress: activeProctors.filter((p) => p.status === 'In Progress').length,
      verified: activeProctors.filter((p) => p.status === 'Verified').length,
      active: activeProctors.filter((p) => p.status === 'Active').length,
      offboarded: allProctors.filter((p) => p.status === 'Offboarded').length,
      interviewSelects,
      bgvMissing: bgvMissing.length,
      bgvOverdue,
      demoCert,
      assessCert,
      byVendor: {} as Record<string, any>,
    };

    // Count by ALL unique vendors found in data (like HTML app using VENDORS.map)
    const allVendors = [...new Set(allProctors.map(p => p.vendor || p.managed_by).filter(Boolean))];
    
    allVendors.forEach((v) => {
      const vendorProctors = activeProctors.filter(p => (p.vendor || p.managed_by) === v);
      const vendorBgvMissing = vendorProctors.filter(p => p.status === 'Active' && !p.bgv);
      const vendorBgvOverdue = vendorBgvMissing.filter(p => {
        if (!p.aat) return false;
        const activatedDate = new Date(p.aat);
        const daysSinceActivated = Math.floor((Date.now() - activatedDate.getTime()) / (1000 * 60 * 60 * 24));
        return daysSinceActivated > BGV_DUE_DAYS;
      }).length;
      
      stats.byVendor[v] = {
        total: vendorProctors.length,
        inProgress: vendorProctors.filter(p => p.status === 'In Progress').length,
        active: vendorProctors.filter(p => p.status === 'Active').length,
        bgvMissing: vendorBgvMissing.length,
        bgvOverdue: vendorBgvOverdue,
        demoCert: vendorProctors.filter(p => p.demo_ready === 'pass').length,
        assessCert: vendorProctors.filter(p => p.assessment_ready === 'pass').length,
      };
    });

    return stats;
  },

  /**
   * Upload file to Supabase storage
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

    // Return public URL
    const { data: urlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(data.path);

    return urlData.publicUrl;
  },
};
