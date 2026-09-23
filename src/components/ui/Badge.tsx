import type { ProctorStatus } from '@/types';

interface BadgeProps {
  status: ProctorStatus;
}

// Matches the "Proctor OS" reference artifact's own badge color mapping exactly
// (its b-progress/b-verified/b-active/b-offboarded classes) -- In Progress is
// informational (blue), Verified is the "needs a next action" amber, Active is
// green, and Offboarded is a neutral gray, not a danger red (offboarding is a
// normal terminal state, not a failure).
const statusStyles: Record<ProctorStatus, string> = {
  'In Progress': 'bg-info/15 text-info border-info/30',
  'Verified': 'bg-warning/15 text-warning border-warning/30',
  'Active': 'bg-success/15 text-success border-success/30',
  'Offboarded': 'bg-text3/15 text-text3 border-text3/30',
  'Archived': 'bg-text3/15 text-text3 border-text3/30',
};

export default function Badge({ status }: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center justify-center gap-1 px-2 py-1 rounded-full
        min-w-[88px] whitespace-nowrap text-[11px] font-bold border
        ${statusStyles[status]}
      `}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
