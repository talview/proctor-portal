import type { Vendor, ProctorType } from '@/types';

export const VENDORS: Vendor[] = ['Sai', 'TSN', 'Avner', 'A&M', 'ATS', 'Awign'];

export const PROCTOR_TYPES: ProctorType[] = ['WFO', 'ODP', 'Hybrid'];

export const PROCTOR_TYPE_LABELS: Record<ProctorType, string> = {
  WFO: 'WFO — Work from Office',
  ODP: 'ODP — On Demand Proctor',
  Hybrid: 'Hybrid — In Office On Demand',
};

// Shared by ProctorsPage's paginated table search and proctorService.getAll's export
// search -- one list so the two can't silently diverge on what's searchable (phone
// was deliberately dropped from search; a second hand-copied list let export keep
// searching it anyway until this was unified).
export const PROCTOR_SEARCH_COLUMNS: string[] = ['name', 'email', 'pid'];

export const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
];

// Matches the "Proctor OS" reference artifact's own status color mapping (see
// Badge.tsx, the actual rendered status pill, for the single source of truth).
export const STATUS_COLORS = {
  'In Progress': 'info',
  Verified: 'warning',
  Active: 'success',
  Offboarded: 'neutral',
  Archived: 'secondary',
} as const;

export const STATUS_BADGES = {
  'In Progress': 'bg-info/15 text-info',
  Verified: 'bg-warning/15 text-warning',
  Active: 'bg-success/15 text-success',
  Offboarded: 'bg-text3/15 text-text3',
  Archived: 'bg-text3/15 text-text3',
} as const;

/** Evaluation result reason options, keyed by result -- shown in a dropdown that
 * depends on the selected result, in both the Evaluations page and Workspace's
 * evaluation result modals. */
export const EVAL_REASON_OPTIONS_BY_RESULT: Record<string, string[]> = {
  Pass: ['Strong overall performance', 'Excellent communication', 'Met all criteria', 'Good technical knowledge'],
  Reattempt: ['Needs more preparation', 'Communication issues', 'Incomplete responses', 'Technical knowledge gaps', 'Nervousness/confidence issues'],
  'No Show': ['Proctor did not show up', 'Connection issues reported', 'Notified late cancellation', 'No prior notice'],
  Reschedule: ['Rescheduled by proctor', 'Rescheduled by panel', 'Technical issues during session', 'Emergency situation'],
};
