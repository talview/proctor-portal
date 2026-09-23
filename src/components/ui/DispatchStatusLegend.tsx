import { Circle, Send, Eye, Clock, XCircle, CheckCircle2 } from 'lucide-react';
import StatusLegend from './StatusLegend';

const ITEMS = [
  { Icon: Circle, label: 'Not Sent', desc: 'Nothing sent yet', className: 'text-text3' },
  { Icon: Send, label: 'Sent', desc: 'Delivered, not opened', className: 'text-accent' },
  { Icon: Eye, label: 'Viewed', desc: 'Candidate opened the link', className: 'text-accent' },
  { Icon: Clock, label: 'Expired', desc: 'Link expired before completion', className: 'text-danger' },
  { Icon: XCircle, label: 'Failed', desc: 'Send attempt failed', className: 'text-danger' },
  { Icon: CheckCircle2, label: 'Completed', desc: 'Signed / uploaded / submitted', className: 'text-success' },
];

/** Hover trigger next to a DispatchStatusCell-driven column header -- the icon
 * vocabulary (see DispatchStatusCell) isn't self-explanatory from a single
 * glyph in an 11px table cell, so this spells it out once, in place, instead
 * of relying on a README or tribal knowledge. */
export default function DispatchStatusLegend() {
  return <StatusLegend title="Dispatch status" items={ITEMS} />;
}
