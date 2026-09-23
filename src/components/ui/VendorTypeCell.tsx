/** Vendor name on top, proctor type (ODP/WFO/Hybrid) beneath it in smaller muted
 * text -- shared by ProctorsPage and IncompletePage so the two can't drift apart. */
export default function VendorTypeCell({ vendor, ptype }: { vendor?: string | null; ptype?: string | null }) {
  return (
    <div className="leading-tight whitespace-nowrap">
      <div className="text-[12px] text-text2 font-medium">{vendor || '—'}</div>
      {ptype && <div className="text-[10px] text-text3">{ptype}</div>}
    </div>
  );
}
