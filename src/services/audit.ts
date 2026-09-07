import { supabase } from './supabase';

export interface AuditEntry {
  action: string;
  target: string;
  detail: string;
  /** @deprecated the acting user is now derived server-side from the session, not the client */
  user?: string | null;
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const { error } = await supabase.rpc('log_audit', {
      p_action: entry.action,
      p_target: entry.target,
      p_detail: entry.detail,
    });

    if (error) {
      console.error('Audit log write failed:', error);
    }
  } catch (error) {
    console.error('Audit log write failed:', error);
  }
}
