// Core types for the Proctor Portal

export type UserRole = 'admin' | 'vendor' | 'coordinator';

export type ProctorStatus = 'In Progress' | 'Verified' | 'Active' | 'Offboarded' | 'Archived';

export type ProctorType = 'WFO' | 'ODP' | 'Hybrid';

export type Vendor = 'Sai' | 'TSN' | 'Avner' | 'A&M' | 'ATS' | 'Awign';

export type EvaluationStatus = 
  | 'Not Started' 
  | 'Ready' 
  | 'Scheduled' 
  | 'Pass' 
  | 'Fail' 
  | 'Reattempt' 
  | 'No Show' 
  | 'Reschedule';

export type NDAStatus = 'Not Sent' | 'Shared' | 'NDA Signed';

export interface User {
  id: string;
  username: string;
  name: string;
  email: string;
  role: UserRole;
  vendor?: Vendor;
  created_at: string;
  updated_at: string;
}

export interface Proctor {
  id: string;
  pid?: string;
  name: string;
  aadhaar: string;
  vendor?: string; // Used in HTML app (same as managed_by)
  phone: string;
  email: string;
  address?: string;
  city: string;
  state: string;
  dob: string;
  gender: 'Male' | 'Female' | 'Other';
  ptype: ProctorType;
  bgv?: string;
  nda?: string;
  notes?: string;
  status: ProctorStatus;
  stage?: number;
  
  // Metadata (database column names)
  by_user?: string; // created by user
  at: string; // created timestamp
  upd: string; // updated timestamp
  vby?: string; // verified by
  vat?: string | null; // verified at
  aat?: string | null; // activated at
  oat?: string | null; // offboarded at
  off_reason?: string;
  off_notes?: string;
  
  // Evaluation fields
  demo_eval?: string;
  assessment?: string;
  demo_ready?: string;
  assessment_ready?: string;
  demo_ready_attempt?: number;
  assessment_ready_attempt?: number;
  
  // NDA fields
  nda_status?: string;
  nda_triggered_at?: string | null;
  nda_triggered_by?: string;
  nda_link_expires_at?: string | null;
  nda_signed_at?: string | null;
  nda_file_url?: string;
  
  // Interview select / onboarding form fields
  interview_stage?: string;
  form_status?: string;
  form_link_token?: string;
  form_shared_at?: string | null;
  form_submitted_at?: string | null;
  form_link_expires_at?: string | null;
  managed_by: Vendor;
  vendor_verified?: boolean;
  vendor_verified_by?: string;
  vendor_verified_at?: string | null;
  final_form_status?: string;
  
  // Compatibility aliases (for React code readability)
  created_at?: string;
  updated_at?: string;
  created_by?: string;
}

export interface InterviewSelect {
  id: string;
  email: string;
  managed_by: Vendor;
  ptype: ProctorType;
  notes?: string;
  form_status: 'not_sent' | 'shared' | 'submitted';
  form_link?: string;
  submitted_at?: string;
  created_at: string;
}

export interface Evaluation {
  id: string;
  proctor_id: string;
  proctor_email?: string;
  proctor_name?: string;
  eval_type: 'demo' | 'assessment'; // Database uses eval_type not type
  panel_id?: string;
  panel_user: string; // Database uses panel_user not panel_name
  scheduled_date: string;
  scheduled_time?: string;
  score?: number;
  score_out_of?: number;
  result?: 'Pass' | 'Fail' | 'Reattempt' | 'No Show' | 'Reschedule';
  comment?: string;
  attempt_number: number;
  certified_date?: string;
  group_id?: string;
  status?: string;
  score_obtained?: number;
  overridden_by?: string;
  overridden_at?: string;
  session_code?: string;
  candidate_id?: string;
  section_id?: string;
  result_url?: string;
  created_at: string;
  created_by?: string;
  updated_at?: string;
}

export interface Note {
  id: string;
  user_id: string;
  title: string;
  body: string;
  color?: 'red' | 'yellow' | 'green' | 'blue';
  colour?: 'red' | 'yellow' | 'green' | 'blue';
  done: boolean;
  due_date?: string;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  ts: string;        // timestamp
  usr: string;       // username
  action: string;
  target: string;
  detail: string;
}

export interface AppConfig {
  key: string;
  value: string;
}

// Dashboard statistics
export interface DashboardStats {
  total: number;
  inProgress: number;
  verified: number;
  active: number;
  offboarded: number;
  byVendor: Record<Vendor, number>;
}

// Filter types
export interface ProctorFilters {
  search?: string;
  vendor?: Vendor | '';
  status?: ProctorStatus | '';
  ptype?: ProctorType | '';
  /** Derived from final_form_status + nda_link_expires_at, not a stored column value
   * on its own -- see the Documents column's badge logic in ProctorsPage.tsx. */
  docsStatus?: 'not_started' | 'pending' | 'expired' | 'submitted' | '';
}

// Interview Selects list filters -- 'status' mirrors the Form Status column's
// derived states (see InterviewSelectsPage's getStatusBadge): 'expired' isn't a
// stored value on its own, it's a 'shared' row whose form_link_expires_at has
// passed.
export interface InterviewSelectFilters {
  search?: string;
  vendor?: Vendor | '';
  status?: 'not_sent' | 'shared' | 'expired' | 'submitted' | '';
}

/** Tab 0 (flat "Offboarded" list) of OffboardedPage only -- the "Re-onboard History"
 * tab groups Archived records by aadhaar across the whole archived population and
 * isn't a filtered/paginated list, so it has no filters type of its own. */
export interface OffboardedFilters {
  search?: string;
  vendor?: Vendor | '';
}

export interface EvaluationFilters {
  search?: string;
  vendor?: Vendor | '';
  ptype?: ProctorType | '';
  result?: EvaluationStatus | '';
  date?: string;
}

/** Filters for WorkspacePage's "Scheduled Events" tab. `date`/`type` are plain
 * columns on proctor_evaluations and are applied server-side; `vendor`/`ptype`
 * filter on the joined proctor (proctor_evaluations has no FK relationship
 * registered with `proctors` in PostgREST's schema cache, so an embedded-resource
 * filter isn't available) and are applied client-side to the current page only --
 * see the ScheduledEventsTab comment above its query for the accuracy tradeoff. */
export interface ScheduledEventFilters {
  date?: string;
  type?: Evaluation['eval_type'] | '';
  vendor?: Vendor | '';
  ptype?: ProctorType | '';
}
