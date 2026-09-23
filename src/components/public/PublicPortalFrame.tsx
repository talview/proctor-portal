import type { ReactNode } from 'react';
import markWhite from '@/assets/branding/talview-mark-white.png';

export interface PublicPortalStep {
  label: string;
}

interface PublicPortalFrameProps {
  /** Shown next to the logo, e.g. "Proctor Onboarding" / "NDA Signing". */
  title: string;
  /** Dynamic per-step heading in the sidebar -- distinct from each step's own
   * in-content heading, so the two never read as the same sentence twice. */
  heading: string;
  subtitle: string;
  steps: PublicPortalStep[];
  /** -1 hides the step list entirely (terminal/error states that aren't part
   * of the normal step flow -- invalid link, expired, already submitted). */
  currentStepIndex: number;
  /** The 'sign' step needs real room for a PDF; everything else is a form. */
  wide?: boolean;
  children: ReactNode;
}

/** Shared split-panel shell for both public candidate flows (pre-onboarding
 * form, NDA e-signature): a constant dark sidebar carries the brand and step
 * progress, the white pane carries the actual step -- same pattern as the ops
 * console's Sidebar (a fixed dark anchor, not something that flips with a
 * theme, since there's no theme toggle on a public link anyway) and the same
 * violet-navy family. Deliberately owns only the chrome: every step's actual
 * content, validation, and API calls stay exactly where they were, in the
 * page components that render inside this frame's children slot. */
export default function PublicPortalFrame({
  title,
  heading,
  subtitle,
  steps,
  currentStepIndex,
  wide,
  children,
}: PublicPortalFrameProps) {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4 sm:p-6">
      <div
        className={`w-full h-[calc(100vh-2rem)] sm:h-[calc(100vh-3rem)] bg-surface border border-border rounded-2xl overflow-hidden flex flex-col md:flex-row ${
          wide ? 'max-w-6xl' : 'max-w-3xl'
        }`}
      >
        <aside
          className="md:w-[260px] flex-shrink-0 p-6 sm:p-7 flex flex-col justify-between text-white overflow-y-auto"
          style={{ background: 'linear-gradient(180deg, #15132A 0%, #211D45 100%)' }}
        >
          <div>
            <div className="flex items-center gap-2.5 mb-7">
              <img src={markWhite} alt="Talview" className="h-8 w-8 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-[13px] font-bold leading-tight">Talview</div>
                <div className="text-[10px] text-white/50 leading-tight truncate">{title}</div>
              </div>
            </div>

            {currentStepIndex >= 0 && (
              <>
                <h2 className="text-base font-bold mb-2 leading-snug">{heading}</h2>
                <p className="text-[11.5px] text-white/55 leading-relaxed mb-7">{subtitle}</p>

                <div>
                  {steps.map((s, i) => {
                    const done = i < currentStepIndex;
                    const current = i === currentStepIndex;
                    return (
                      <div key={s.label} className="flex gap-2.5" style={{ paddingBottom: i === steps.length - 1 ? 0 : 20 }}>
                        <div className="flex flex-col items-center flex-shrink-0">
                          <div
                            className={`w-[22px] h-[22px] rounded-full flex items-center justify-center text-[10px] font-bold border transition-colors ${
                              done
                                ? 'bg-success border-success text-white'
                                : current
                                  ? 'bg-white border-white text-[#15132A]'
                                  : 'bg-transparent border-white/25 text-white/40'
                            }`}
                          >
                            {done ? '✓' : i + 1}
                          </div>
                          {i < steps.length - 1 && (
                            <div className={`w-px flex-1 mt-1 ${done ? 'bg-success/60' : 'bg-white/15'}`} style={{ minHeight: 14 }} />
                          )}
                        </div>
                        <span className={`text-[12.5px] font-medium pt-0.5 ${current ? 'text-white' : done ? 'text-white/75' : 'text-white/40'}`}>
                          {s.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </aside>

        <div className="flex-1 min-w-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
