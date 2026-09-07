import type { ProctorStatus } from '@/types';

interface BadgeProps {
  status: ProctorStatus;
}

const statusStyles: Record<ProctorStatus, string> = {
  'In Progress': 'bg-warning/15 text-warning border-warning/30',
  'Verified': 'bg-info/15 text-info border-info/30',
  'Active': 'bg-success/15 text-success border-success/30',
  'Offboarded': 'bg-danger/15 text-danger border-danger/30',
  'Archived': 'bg-text3/15 text-text3 border-text3/30',
};

export default function Badge({ status }: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-full
        min-w-[98px] text-[11px] font-bold border
        ${statusStyles[status]}
      `}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
