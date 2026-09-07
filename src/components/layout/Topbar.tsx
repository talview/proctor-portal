import { useState, useEffect } from 'react';
import PageSwitcher from './PageSwitcher';

export default function Topbar() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const istTime = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  const utcTime = now.toLocaleTimeString('en-GB', { timeZone: 'UTC' });

  return (
    <div className="bg-white border-b border-border px-6 h-14 flex items-center justify-between gap-3 sticky top-0 z-40 shadow-sm">
      <div className="flex-1 min-w-0 overflow-x-auto">
        <PageSwitcher />
      </div>
      <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
        <span className="text-[11px] text-text3">
          {istTime} IST
        </span>
        <span className="text-[11px] text-text3 border-l border-border pl-3">
          {utcTime} UTC
        </span>
      </div>
    </div>
  );
}
