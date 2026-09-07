import type { Vendor, ProctorType } from '@/types';

export const VENDORS: Vendor[] = ['Sai', 'TSN', 'Avner', 'A&M', 'ATS', 'Awign'];

export const PROCTOR_TYPES: ProctorType[] = ['WFO', 'ODP', 'Hybrid'];

export const PROCTOR_TYPE_LABELS: Record<ProctorType, string> = {
  WFO: 'WFO — Work from Office',
  ODP: 'ODP — On Demand Proctor',
  Hybrid: 'Hybrid — In Office On Demand',
};

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

export const STATUS_COLORS = {
  'In Progress': 'warning',
  Verified: 'info',
  Active: 'success',
  Offboarded: 'danger',
  Archived: 'secondary',
} as const;

export const STATUS_BADGES = {
  'In Progress': 'bg-warning/15 text-warning',
  Verified: 'bg-info/15 text-info',
  Active: 'bg-success/15 text-success',
  Offboarded: 'bg-danger/15 text-danger',
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
