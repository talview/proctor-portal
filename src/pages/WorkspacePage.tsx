import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calendar, StickyNote, Pencil, Trash2, Save, Plus, ListChecks, ChevronDown } from 'lucide-react';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import { showAlert } from '@/components/ui/GlobalDialog';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import Avatar from '@/components/ui/Avatar';
import { useUpcomingReminders, reminderTitle, reminderDescription, reminderBadge, type ReminderItem } from '@/hooks/useUpcomingReminders';
import { localDateString } from '@/utils/formatters';
import type { Note } from '@/types';

// Same react-query key NotesPanel's own notes query uses -- reusing it here (rather
// than a second, differently-keyed query) means react-query dedupes the two into
// one request/cache entry instead of fetching the same rows twice.
const NOTES_QUERY_KEY = (userId: string | undefined) => ['user-notes', userId];

/** Shared by both PriorityTasksSection and NotesPanel: while a stack is
 * expanded, a click anywhere outside the panel collapses it back, same as a
 * dropdown/popover -- not just the explicit "Collapse" link in the header. */
function useCollapseOnOutsideClick(active: boolean, onCollapse: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCollapse();
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [active, onCollapse]);
  return ref;
}

/** Time-of-day greeting -- computed locally off the browser clock, same pattern
 * Topbar's own clock already uses (no shared "current time" hook exists to reuse). */
function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Same route split the sidebar/CommandPalette already use for this page -- admin's
 * Proctors table lives at /proctors, coordinator lands on /my-proctors. Duplicated
 * here rather than imported (it's a one-line lookup, not shared internals worth a
 * cross-module dependency). */
function proctorsPathFor(role: string | undefined) {
  return role === 'admin' ? '/proctors' : '/my-proctors';
}

/** Purely a reminder space: a read-only glance at what's scheduled (no Evaluate
 * action -- that workflow now lives on its own page, Scheduled Events, under
 * Certification) plus personal notes. The full schedule board itself lives
 * only on Scheduled Events now -- this page used to also render a read-only
 * copy of it below Upcoming Tasks, which was pure duplication (identical data,
 * identical component, just without the evaluate actions); Upcoming Tasks
 * already surfaces the handful that matter most, and "+N more" links straight
 * to Scheduled Events for everything else.
 *
 * The page itself is a non-scrolling shell -- h-full resolves against
 * MainLayout's now properly height-bounded content area (see its own comment),
 * not a guessed pixel value -- both panels below scroll independently inside
 * their own bounded height instead of growing the document, so neither a long
 * task list nor a long note list ever pushes the other off-screen or requires
 * scrolling past one to reach the other. */
export default function WorkspacePage() {
  const { user } = useAuthStore();

  // Vendor can't reach this page at all -- RoleGate (App.tsx) restricts the
  // /workspace route to admin/coordinator before this component ever mounts.
  const firstName = user?.name?.split(' ')[0] || 'there';
  const greeting = `${greetingFor(new Date())}, ${firstName}`;

  return (
    // Static page, no scroll -- h-full + overflow-hidden resolves against
    // MainLayout's own bounded content area. The summary tiles and greeting are
    // fixed-height (flex-shrink-0); Priority Tasks and Notes share the remaining
    // height side by side (flex-1 min-h-0), each scrolling internally once its
    // own list grows past what that column has room for, so nothing ever pushes
    // the page itself into a scrollbar.
    <div className="h-full flex flex-col overflow-hidden">
      <div className="mb-6 flex items-center gap-3 flex-shrink-0">
        <Avatar name={user?.name} size="lg" />
        <div>
          <h2 className="text-[20px] font-bold text-text">{greeting}</h2>
          <p className="text-[13px] text-text2 mt-0.5">Your schedule at a glance and personal notes -- for evaluating a session, see Scheduled Events</p>
        </div>
      </div>

      <div className="flex-shrink-0">
        <WorkspaceSummary />
      </div>

      {/* flex, not grid -- a CSS Grid's implicit row defaults to auto-sizing (as
          tall as its content wants), which silently ignores flex-1/min-h-0 on
          the grid container itself and let each panel's h-full resolve to its
          own natural content height instead of the real space available (the
          exact bug: at a shorter window height, panels quietly overflowed the
          page instead of scrolling internally). Flexbox's min-h-0 is the same
          fix already used everywhere else in this app's shell (MainLayout,
          Sidebar) for exactly this class of problem, so this just matches that
          proven pattern instead of fighting Grid's own sizing rules. */}
      <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0 mt-6">
        <PriorityTasksSection />
        <NotesPanel />
      </div>
    </div>
  );
}

// ============================================
// SUMMARY -- 4 at-a-glance tiles above the two sections below. Overdue/Due Today
// are raw record counts (an eval bucket's real `count`, an NDA item as 1 each),
// deliberately different from Priority Tasks' own "N open" (a count of *cards*,
// i.e. buckets) -- "35 pending demos" is one card but 35 overdue records, and
// both numbers are real/useful, just answering different questions.
// ============================================
function isOverdueItem(item: ReminderItem, today: string): boolean {
  if (item.kind === 'eval') return item.date < today;
  return new Date(item.proctor.nda_link_expires_at).getTime() < Date.now();
}
function isDueTodayItem(item: ReminderItem, today: string): boolean {
  if (item.kind === 'eval') return item.date === today;
  const diffDays = Math.ceil((new Date(item.proctor.nda_link_expires_at).getTime() - Date.now()) / 86_400_000);
  return diffDays === 0;
}
const rawItemCount = (item: ReminderItem) => (item.kind === 'eval' ? item.count : 1);

const TILE_STYLES: Record<'danger' | 'warning' | 'neutral', { box: string; label: string; value: string; caption: string }> = {
  danger: { box: 'bg-danger/10 border-danger/20', label: 'text-danger', value: 'text-danger', caption: 'text-danger/80' },
  warning: { box: 'bg-warning/10 border-warning/20', label: 'text-warning', value: 'text-warning', caption: 'text-warning/80' },
  neutral: { box: 'bg-surface2 border-border', label: 'text-text3', value: 'text-text', caption: 'text-text3' },
};

function WorkspaceSummary() {
  const { user } = useAuthStore();
  const { items, today } = useUpcomingReminders();
  const { data: notes = [] } = useQuery({
    queryKey: NOTES_QUERY_KEY(user?.id),
    queryFn: async () => {
      const { data, error } = await supabase.from('user_notes').select('*').eq('user_id', user?.id).order('created_at', { ascending: false });
      if (error) throw error;
      return data as Note[];
    },
  });
  // A separate, lightweight count -- useUpcomingReminders only ever fetches
  // overdue-or-due-today evaluations (by design, for Priority Tasks/the
  // notification bell); "next 7 days" needs the genuinely-future window those
  // deliberately exclude, so this queries it directly rather than widening that
  // hook's own scope for every one of its other consumers.
  const { data: upcoming7dCount = 0 } = useQuery({
    queryKey: ['workspace-upcoming-7d', user?.username, today],
    queryFn: async () => {
      const future = new Date(today + 'T00:00:00');
      future.setDate(future.getDate() + 7);
      let query = supabase
        .from('proctor_evaluations')
        .select('id', { count: 'exact', head: true })
        .is('result', null)
        .gt('scheduled_date', today)
        .lte('scheduled_date', localDateString(future));
      if (user?.role !== 'admin') query = query.eq('panel_user', user?.username);
      const { count, error } = await query;
      if (error) throw error;
      return count || 0;
    },
  });

  const overdueCount = items.filter((i) => isOverdueItem(i, today)).reduce((sum, i) => sum + rawItemCount(i), 0);
  const dueTodayCount = items.filter((i) => isDueTodayItem(i, today)).reduce((sum, i) => sum + rawItemCount(i), 0);
  // NDA links expiring in 1-3 days -- neither overdue nor due today, so they
  // belong in "Upcoming" alongside the next-7-days evaluation count above.
  const ndaUpcomingCount = items.filter((i) => !isOverdueItem(i, today) && !isDueTodayItem(i, today)).length;

  const tiles: { label: string; value: number; caption: string; tone: 'danger' | 'warning' | 'neutral' }[] = [
    { label: 'Overdue', value: overdueCount, caption: 'Needs attention', tone: 'danger' },
    { label: 'Due Today', value: dueTodayCount, caption: 'Before end of day', tone: 'warning' },
    { label: 'Upcoming', value: upcoming7dCount + ndaUpcomingCount, caption: 'Next 7 days', tone: 'neutral' },
    { label: 'My Notes', value: notes.length, caption: 'Personal reminders', tone: 'neutral' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {tiles.map((t) => {
        const s = TILE_STYLES[t.tone];
        return (
          <div key={t.label} className={`rounded-lg border p-4 ${s.box}`}>
            <div className={`text-[11px] font-bold uppercase tracking-wide ${s.label}`}>{t.label}</div>
            <div className={`text-[26px] font-display font-bold mt-1 ${s.value}`}>{t.value}</div>
            <div className={`text-[12px] mt-0.5 ${s.caption}`}>{t.caption}</div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================
// UPCOMING TASKS -- a short, capped digest of what needs attention soonest,
// backed by the same useUpcomingReminders hook the notification bell uses (see
// src/hooks/useUpcomingReminders.ts for the full rationale/query details). This
// duplicates none of ScheduleBoard's data model -- the full backlog is already
// fully visible on Scheduled Events itself; this section exists purely to
// surface the handful that matter most without requiring a scroll through
// everything else. Clicking a demo/assessment card goes to Scheduled Events,
// pre-filtered to that exact date/type; clicking an NDA card opens that
// proctor's record.
// ============================================
// How many items show as full, open cards before the rest collapse into the
// stack -- mirrors NotesPanel's own VISIBLE_NOTE_COUNT treatment below.
// Side-by-side with Notes now, each panel has real height to spare below 2 short
// cards -- 4 fills that space without turning the digest into "show everything".
// Task cards are more compact than note cards (one line + a badge, no due-date/
// edit/delete rows), so this panel has room for more before hitting the same
// bottom boundary Notes does at 3.
const VISIBLE_TASK_COUNT = 5;

function PriorityTasksSection() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [stackExpanded, setStackExpanded] = useState(false);
  const collapseRef = useCollapseOnOutsideClick(stackExpanded, () => setStackExpanded(false));
  const { items, today, isLoading } = useUpcomingReminders();

  const visible = items.slice(0, VISIBLE_TASK_COUNT);
  const overflow = items.slice(VISIBLE_TASK_COUNT);

  const openReminder = (item: ReminderItem) => {
    if (item.kind === 'eval') {
      navigate('/scheduled-events', { state: { filters: { date: item.date, type: item.evalType } } });
    } else {
      navigate(proctorsPathFor(user?.role), { state: { openProctorId: item.proctor.id } });
    }
  };

  const renderItem = (item: ReminderItem) => (
    <TaskDigestCard
      key={item.kind === 'eval' ? `${item.evalType}-${item.date}` : item.proctor.id}
      title={reminderTitle(item)}
      badge={reminderBadge(item, today)}
      description={reminderDescription(item)}
      onOpen={() => openReminder(item)}
    />
  );

  return (
    <div ref={collapseRef} className="bg-surface border border-border rounded-lg p-4 h-full flex-1 min-h-0 min-w-0 flex flex-col">
      {/* Header (+ the Collapse control, once expanded) stays outside the
          scrolling region below it, so both are always visible regardless of
          how far the list itself is scrolled. */}
      <div className="flex items-end justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <ListChecks className="w-4 h-4 text-text3" />
          <div>
            <h3 className="text-[15px] font-bold text-text leading-tight">Priority Tasks</h3>
            <p className="text-[12px] text-text3 mt-0.5">What needs your attention</p>
          </div>
        </div>
        {stackExpanded ? (
          <button type="button" onClick={() => setStackExpanded(false)} className="text-[12px] font-semibold text-accent hover:underline flex-shrink-0">
            Collapse
          </button>
        ) : (
          items.length > 0 && <span className="text-[12px] text-text3 flex-shrink-0">{items.length} open</span>
        )}
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center gap-3 py-8">
          <LoadingSpinner size="md" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={ListChecks} title="All caught up" message="Nothing needs attention right now." compact />
      ) : (
        // Always the panel's own internal scroll region (flex-1 min-h-0), not a
        // fixed pixel max-height -- the panel itself is already height-bounded by
        // the page's side-by-side grid, so this naturally fills whatever room
        // that leaves, whether collapsed (short) or expanded (long).
        <div className="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1">
          {visible.map(renderItem)}
          {overflow.length > 0 &&
            (stackExpanded ? (
              overflow.map(renderItem)
            ) : (
              <PeekStack
                peekTones={overflow.slice(0, 2).map((item) => reminderBadge(item, today).tone)}
                label={`+${overflow.length} more`}
                onExpand={() => setStackExpanded(true)}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function TaskDigestCard({
  title,
  badge,
  description,
  onOpen,
}: {
  title: string;
  badge: { label: string; tone: 'danger' | 'warning' };
  description: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${title} — ${description}`}
      className="w-full text-left bg-surface border border-border rounded-lg px-3 py-2.5 hover:border-border2 hover:shadow-sm transition-all"
    >
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="text-[12.5px] font-bold text-text truncate">{title}</span>
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${
            badge.tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'
          }`}
        >
          {badge.label}
        </span>
      </div>
      <div className="text-[11px] text-text3 truncate">{description}</div>
    </button>
  );
}

// ============================================
// NOTES PANEL -- previously its own tab ("My Notes"); now a persistent sidebar
// next to the schedule instead of a click away. Same query/mutations, just a
// narrower vertical layout in place of the old 4-column grid.
// ============================================
// How many notes show as full, open cards before the rest collapse into the stack.
const VISIBLE_NOTE_COUNT = 3;

function NotesPanel() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [stackExpanded, setStackExpanded] = useState(false);
  const collapseRef = useCollapseOnOutsideClick(stackExpanded, () => setStackExpanded(false));

  const { data: notes = [], isLoading } = useQuery({
    queryKey: NOTES_QUERY_KEY(user?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_notes')
        .select('*')
        .eq('user_id', user?.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data as Note[];
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('user_notes').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-notes'] });
    },
  });

  const toggleDoneMutation = useMutation({
    mutationFn: async ({ id, done }: { id: string; done: boolean }) => {
      const { error } = await supabase.from('user_notes').update({ done }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-notes'] });
    },
  });

  return (
    <div ref={collapseRef} className="bg-surface border border-border rounded-lg p-4 h-full flex-1 min-h-0 min-w-0 flex flex-col">
      {/* Header (+ Collapse, once expanded) stays outside the scrolling region
          below it, same treatment as Priority Tasks. */}
      <div className="flex items-end justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <StickyNote className="w-4 h-4 text-text3" />
          <div>
            <h3 className="text-[15px] font-bold text-text leading-tight">Notes</h3>
            <p className="text-[12px] text-text3 mt-0.5">Only visible to you</p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {stackExpanded && (
            <button type="button" onClick={() => setStackExpanded(false)} className="text-[12px] font-semibold text-accent hover:underline">
              Collapse
            </button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditingNote(null);
              setShowModal(true);
            }}
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </Button>
        </div>
      </div>

      {/* Notes list -- a narrow vertical stack, not the old 4-column grid, since
          this now shares the page with tasks instead of having it to itself.
          Sorted by nearest due date first (undated notes sort last) so the 2 that
          stay open as full cards are the most time-sensitive ones; anything past
          that collapses into a single fanned "stack" (like an iOS/macOS notification
          stack) instead of pushing the panel's height out indefinitely. */}
      {isLoading ? (
        <div className="flex flex-col items-center gap-3 py-8">
          <LoadingSpinner size="md" />
        </div>
      ) : notes.length === 0 ? (
        <EmptyState icon={StickyNote} title="No notes yet" message="Click Add to create one." compact />
      ) : (
        (() => {
          const sorted = [...notes].sort((a, b) => {
            const aDue = a.due_date ? new Date(a.due_date).getTime() : Infinity;
            const bDue = b.due_date ? new Date(b.due_date).getTime() : Infinity;
            return aDue - bDue;
          });
          const visible = sorted.slice(0, VISIBLE_NOTE_COUNT);
          const overflow = sorted.slice(VISIBLE_NOTE_COUNT);

          const renderCard = (note: Note) => (
            <NoteCard
              key={note.id}
              note={note}
              onEdit={() => {
                setEditingNote(note);
                setShowModal(true);
              }}
              onDelete={() => deleteMutation.mutate(note.id)}
              onToggleDone={() =>
                toggleDoneMutation.mutate({ id: note.id, done: !note.done })
              }
            />
          );

          // Same collapsed-natural-height / expanded-fixed-height-with-internal-
          // scroll treatment as Priority Tasks -- Collapse lives in the header
          // above, not down here, so it stays visible while this scrolls.
          return (
            <div className="space-y-2.5 flex-1 min-h-0 overflow-y-auto pr-1">
              {visible.map(renderCard)}

              {overflow.length > 0 &&
                (stackExpanded ? (
                  overflow.map(renderCard)
                ) : (
                  <PeekStack
                    peekTones={overflow.slice(0, 2).map((n) => n.colour || n.color || 'yellow')}
                    label={`+${overflow.length} more note${overflow.length === 1 ? '' : 's'}`}
                    onExpand={() => setStackExpanded(true)}
                  />
                ))}
            </div>
          );
        })()
      )}

      {/* Note Modal */}
      {showModal && (
        <NoteModal
          note={editingNote}
          onClose={() => {
            setShowModal(false);
            setEditingNote(null);
          }}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['user-notes'] });
            setShowModal(false);
            setEditingNote(null);
          }}
        />
      )}
    </div>
  );
}

// Every "tone" either a note's own color or a task's urgency can carry, mapped
// to the sliver's border/fill -- warning/danger reuse the same semantic tokens
// TaskDigestCard's badge already does, so a stacked task's peek matches its own
// (unstacked) badge color.
const PEEK_TONE_CLASSES: Record<string, string> = {
  red: 'bg-red-500/15 border-red-500/30',
  yellow: 'bg-yellow-500/15 border-yellow-500/30',
  green: 'bg-green-500/15 border-green-500/30',
  blue: 'bg-blue-500/15 border-blue-500/30',
  danger: 'bg-danger/15 border-danger/30',
  warning: 'bg-warning/15 border-warning/30',
};

/** A fanned, iOS/macOS-notification-style stack standing in for however many
 * items didn't make the visible-card cut -- a couple of slightly offset
 * "sliver" layers peeking out behind a summary bar, tinted from the actual
 * items underneath so it reads as "more of these," not a generic counter.
 * Clicking it expands the real list in place. Shared by NotesPanel and
 * UpcomingTasksPanel (see each one's own stackExpanded state). */
function PeekStack({ peekTones, label, onExpand }: { peekTones: string[]; label: string; onExpand: () => void }) {
  const peekClasses = peekTones.slice(0, 2).map((t) => PEEK_TONE_CLASSES[t] || PEEK_TONE_CLASSES.yellow);

  return (
    <button type="button" onClick={onExpand} className="relative w-full pt-2 pb-1 text-left group">
      {peekClasses[1] && (
        <div className={`absolute inset-x-3 top-0 h-3.5 rounded-lg border ${peekClasses[1]}`} />
      )}
      {peekClasses[0] && (
        <div className={`absolute inset-x-1.5 top-1 h-3.5 rounded-lg border ${peekClasses[0]}`} />
      )}
      <div className="relative flex items-center justify-between gap-2 bg-surface border border-border rounded-lg px-3 py-2.5 group-hover:border-border2 transition-colors">
        <span className="text-[12px] font-semibold text-text2">{label}</span>
        <ChevronDown className="w-3.5 h-3.5 text-text3" />
      </div>
    </button>
  );
}

interface NoteCardProps {
  note: Note;
  onEdit: () => void;
  onDelete: () => void;
  onToggleDone: () => void;
}

function NoteCard({ note, onEdit, onDelete, onToggleDone }: NoteCardProps) {
  const colorClasses = {
    red: 'bg-red-500/10 border-red-500/30',
    yellow: 'bg-yellow-500/10 border-yellow-500/30',
    green: 'bg-green-500/10 border-green-500/30',
    blue: 'bg-blue-500/10 border-blue-500/30',
  };

  const noteColor = note.colour || note.color || 'yellow';

  return (
    <div
      title={note.body ? `${note.title}\n\n${note.body}` : note.title}
      className={`border rounded-lg p-2.5 ${colorClasses[noteColor as keyof typeof colorClasses]} ${
        note.done ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <h3
          className={`text-[13px] font-bold text-text truncate ${
            note.done ? 'line-through' : ''
          }`}
        >
          {note.title}
        </h3>
        <input
          type="checkbox"
          checked={note.done}
          onChange={onToggleDone}
          className="w-4 h-4 accent-accent cursor-pointer flex-shrink-0"
        />
      </div>
      {note.body && <p className="text-[11.5px] text-text2 mb-2 line-clamp-2">{note.body}</p>}
      {note.due_date && (
        <div className="flex items-center gap-1 text-[11px] text-text3 mb-2">
          <Calendar className="w-3 h-3" /> Due: {new Date(note.due_date).toLocaleDateString('en-IN')}
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="w-3.5 h-3.5" /> Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete}>
          <Trash2 className="w-3.5 h-3.5" /> Delete
        </Button>
      </div>
    </div>
  );
}

interface NoteModalProps {
  note: Note | null;
  onClose: () => void;
  onSuccess: () => void;
}

function NoteModal({ note, onClose, onSuccess }: NoteModalProps) {
  const { user } = useAuthStore();
  const [title, setTitle] = useState(note?.title || '');
  const [body, setBody] = useState(note?.body || '');
  const [color, setColor] = useState<'red' | 'yellow' | 'green' | 'blue'>(
    note?.colour || note?.color || 'yellow'
  );
  const [dueDate, setDueDate] = useState(note?.due_date || '');

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error('Title is required');

      const noteData = {
        title: title.trim(),
        body: body.trim(),
        colour: color, // Database uses 'colour' not 'color'
        due_date: dueDate || null,
        done: note?.done || false,
        user_id: user?.id,
      };

      if (note) {
        const { error } = await supabase
          .from('user_notes')
          .update(noteData)
          .eq('id', note.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('user_notes').insert(noteData);
        if (error) throw error;
      }
    },
    onSuccess,
    onError: (error: any) => {
      showAlert('Error: ' + error.message, { tone: 'error' });
    },
  });

  return (
    <Modal isOpen={true} onClose={onClose} title={note ? 'Edit Note' : 'Add Note'}>
      <div className="space-y-4">
        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">
            Title *
          </label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Note title"
          />
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">Body</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Note content..."
            rows={4}
            className="w-full px-3 py-2 bg-surface2 border border-border rounded-lg text-[13px] text-text outline-none focus:border-accent resize-none"
          />
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">Color</label>
          <div className="flex gap-2">
            {(['red', 'yellow', 'green', 'blue'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-10 h-10 rounded border-2 ${
                  color === c ? 'border-text' : 'border-transparent'
                } ${
                  c === 'red'
                    ? 'bg-red-500/30'
                    : c === 'yellow'
                    ? 'bg-yellow-500/30'
                    : c === 'green'
                    ? 'bg-green-500/30'
                    : 'bg-blue-500/30'
                }`}
              />
            ))}
          </div>
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">
            Due Date (Optional)
          </label>
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>

        <div className="flex gap-2 justify-end pt-4 border-t border-border">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            <Save className="w-4 h-4" /> Save Note
          </Button>
        </div>
      </div>
    </Modal>
  );
}
