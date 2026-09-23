import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import { Search, Loader2, UserRound } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useCommandPaletteStore } from '@/stores/commandPalette';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { getNavSections } from '@/config/navigation';
import { proctorService } from '@/services/proctor';
import { getScopedVendor } from '@/utils/access';
import type { Proctor, Vendor } from '@/types';

const GROUP_HEADING_CLASS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-text3';
const ITEM_CLASS =
  'flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-text cursor-pointer data-[selected=true]:bg-accent/25 data-[selected=true]:text-text';

/** Same route split the sidebar already uses for this page -- admin's Proctors
 * table lives at /proctors, coordinator and vendor both land on the
 * vendor/panel-scoped /my-proctors (see App.tsx's route + RoleGate definitions
 * and navigation.tsx's getNavSections). */
function proctorsPathFor(role: string | undefined) {
  return role === 'admin' ? '/proctors' : '/my-proctors';
}

/** Global Cmd+K / Ctrl+K navigation -- reuses getNavSections, the same
 * role-scoped page list the sidebar already renders, so there's no separate
 * list to keep in sync and nothing shows up here that the current role
 * couldn't already reach from the sidebar. Also searches proctors by
 * name/email/PID (the same fields, same PostgREST-escaped query, and the same
 * vendor-scoping every other proctor search in the app already uses) so this
 * is a genuine record search, not page navigation alone. */
export default function CommandPalette() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const { open, setOpen, toggle } = useCommandPaletteStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [proctorResults, setProctorResults] = useState<Proctor[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, toggle, setOpen]);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  // Clear search state on close so reopening never flashes the previous
  // search's leftover results before the input catches up.
  useEffect(() => {
    if (!open) {
      setSearch('');
      setDebouncedSearch('');
      setProctorResults([]);
    }
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // The same headcount-bound proctors table (and the same PostgREST-escaped
  // ilike search over name/email/pid) every other proctor search in the app
  // already hits -- not a new query pattern, just a new place that calls it.
  // Capped to 8 results: this is a quick-jump, not a search page. Requires 2+
  // characters so a single keystroke doesn't fire a request.
  useEffect(() => {
    if (debouncedSearch.length < 2) {
      setProctorResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    proctorService
      // getScopedVendor returns a plain string (it scopes any non-admin role,
      // not just the hardcoded Vendor union ProctorFilters expects) -- narrowing
      // here is safe since a real user's vendor is always one of that fixed set,
      // or undefined for admin.
      .getAll({ search: debouncedSearch, vendor: getScopedVendor(user) as Vendor | undefined })
      .then(({ rows }) => {
        if (!cancelled) setProctorResults(rows.slice(0, 8));
      })
      .catch(() => {
        if (!cancelled) setProctorResults([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, user]);

  if (!open) return null;

  const sections = getNavSections(user?.role);
  const query = search.trim().toLowerCase();
  // shouldFilter={false} below hands ALL filtering to us -- cmdk's own built-in
  // fuzzy filter operates on every Command.Item's `value` prop with no way to
  // scope it to just the static Pages groups, which risks it silently
  // re-filtering (and hiding) results the server already matched on fields
  // cmdk itself can't see (e.g. a PID match wouldn't obviously fuzzy-match
  // against a value string built from name+vendor alone).
  const filteredSections = query
    ? sections
        .map((section) => ({
          ...section,
          items: section.items.filter((item) => item.label.toLowerCase().includes(query)),
        }))
        .filter((section) => section.items.length > 0)
    : sections;

  const goToProctor = (proctor: Proctor) => {
    navigate(proctorsPathFor(user?.role), { state: { openProctorId: proctor.id } });
    setOpen(false);
  };

  const noResults =
    !searching && proctorResults.length === 0 && filteredSections.every((s) => s.items.length === 0);

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[1200] flex items-start justify-center p-5 pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-lg bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <Command loop label="Quick navigation" shouldFilter={false}>
          <div className="flex items-center gap-2.5 px-4 border-b border-border">
            <Search className="w-4 h-4 text-text3 flex-shrink-0" />
            <Command.Input
              autoFocus
              value={search}
              onValueChange={setSearch}
              placeholder="Jump to a page or search proctors..."
              className="flex-1 bg-transparent py-3.5 text-sm text-text placeholder:text-text3 outline-none"
            />
            {searching && <Loader2 className="w-3.5 h-3.5 text-text3 animate-spin flex-shrink-0" />}
            <kbd className="hidden sm:inline-block text-[10px] font-semibold text-text3 bg-surface2 border border-border rounded px-1.5 py-0.5">
              ESC
            </kbd>
          </div>
          <Command.List className="max-h-80 overflow-y-auto p-2">
            {noResults && (
              <Command.Empty className="py-8 text-center text-sm text-text3">
                No matching page or proctor.
              </Command.Empty>
            )}

            {proctorResults.length > 0 && (
              <Command.Group heading="Proctors" className={GROUP_HEADING_CLASS}>
                {proctorResults.map((proctor) => (
                  <Command.Item
                    key={proctor.id}
                    value={`proctor-${proctor.id}`}
                    onSelect={() => goToProctor(proctor)}
                    className={ITEM_CLASS}
                  >
                    <UserRound className="w-4 h-4 flex-shrink-0 text-text3" />
                    <span className="flex-1 min-w-0 truncate">{proctor.name}</span>
                    <span className="text-xs text-text3 flex-shrink-0 ml-2">
                      {proctor.pid || proctor.vendor || ''}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {filteredSections.map((section) => (
              <Command.Group key={section.title} heading={section.title} className={GROUP_HEADING_CLASS}>
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Command.Item
                      key={item.path}
                      value={item.path}
                      onSelect={() => {
                        navigate(item.path);
                        setOpen(false);
                      }}
                      className={ITEM_CLASS}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      {item.label}
                    </Command.Item>
                  );
                })}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
