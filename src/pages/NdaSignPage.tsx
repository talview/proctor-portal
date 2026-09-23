import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as pdfjsLib from 'pdfjs-dist';
import {
  XCircle,
  Mail,
  Loader2,
  CheckCircle2,
  RefreshCw,
  PartyPopper,
  Upload,
  Eraser,
  PenLine,
  Type as TypeIcon,
  FileText,
  Image as ImageIcon,
  GraduationCap,
  Fingerprint,
  CreditCard,
  Glasses,
  Eye,
  Trash2,
} from 'lucide-react';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { invokeEdgeFunction } from '@/services/supabase';
import { useCooldown, parseCooldownSeconds } from '@/hooks/useCooldown';
import {
  DOCUMENT_FORMAT_HINT,
  computeFileSha256Hex,
  formatFileSize,
  prepareDocumentFile,
  uploadFileWithProgress,
} from '@/utils/documentUpload';
import PublicPortalFrame from '@/components/public/PublicPortalFrame';

const NDA_STEPS = [{ label: 'Authentication' }, { label: 'NDA Signature' }, { label: 'Document Uploads' }];

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

type FieldKind = 'signature' | 'date' | 'full_name' | 'text';
interface TemplateField {
  field_key: string;
  kind: FieldKind;
  label?: string;
  page_index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const DOC_LABELS: Record<string, string> = {
  resume: 'Resume',
  passport_photo: 'Passport Photo',
  grad_cert: 'Graduation Certificate',
  aadhaar_copy: 'Aadhaar Copy',
  pan_copy: 'PAN Copy',
  eye_test: 'Eye Test Report',
};
// One distinct icon per document, standing in for the instructional sentence this
// used to carry (e.g. "A clear copy of your Aadhaar card...") -- the label plus a
// recognizable icon carries the same meaning without the extra reading.
const DOC_ICONS: Record<string, typeof FileText> = {
  resume: FileText,
  passport_photo: ImageIcon,
  grad_cert: GraduationCap,
  aadhaar_copy: Fingerprint,
  pan_copy: CreditCard,
  eye_test: Glasses,
};
const DOC_ORDER = ['resume', 'passport_photo', 'grad_cert', 'aadhaar_copy', 'pan_copy', 'eye_test'];
// At most this many documents upload concurrently -- independent per-kind state below
// means nothing else serializes them, so this cap is the only thing preventing all 6
// from hitting the network at once.
const MAX_CONCURRENT_UPLOADS = 3;

const SIGNATURE_FONTS = ['"Dancing Script", cursive', '"Caveat", cursive', '"Great Vibes", cursive'];

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "06 Sep 2026" -- explicitly IST (matches the date nda-session-submit actually stamps
// onto the signed document server-side, regardless of the signer's own device
// timezone), and the month name is our own fixed abbreviation rather than
// toLocaleDateString's, since browsers' ICU data disagrees on short-month strings for
// en-GB ("Sep" vs "Sept"). No signature-law regime mandates a specific date format;
// this one is chosen because it's unambiguous (unlike MM/DD/YYYY vs DD/MM/YYYY).
function formatIstDateDisplay(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const day = get('day');
  const month = MONTH_ABBR[parseInt(get('month'), 10) - 1];
  const year = get('year');
  return `${day} ${month} ${year}`;
}

type Step = 'loading' | 'error' | 'send_code' | 'otp' | 'sign' | 'upload' | 'success' | 'already_done';

export default function NdaSignPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [step, setStep] = useState<Step>('loading');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [maskedEmail, setMaskedEmail] = useState('');
  const [otp, setOtp] = useState('');
  // Mirrors the server's 30s resend cooldown (nda-session-send-otp) so it's visible
  // up front -- a disabled, counting-down button -- instead of the signer only
  // discovering it exists when a click comes back rejected.
  const resendCooldown = useCooldown();
  const [stepToken, setStepToken] = useState('');
  const [signerName, setSignerName] = useState('');
  const [fieldMap, setFieldMap] = useState<TemplateField[]>([]);
  const [templatePdfUrl, setTemplatePdfUrl] = useState('');
  const [templatePageCount, setTemplatePageCount] = useState(0);
  const [uploadedDocs, setUploadedDocs] = useState<
    { docKind: string; fileName: string; byteSize: number; integrityStatus?: 'pending' | 'verified' | 'mismatch' }[]
  >([]);
  // Mirrors nda-session-status's pdfJobStatus/pdfJobError -- whichever job
  // (sign_render while 'signing', finalize_certificate while 'signed') is currently
  // relevant, so both the Upload step and the Finalize poll can show real progress
  // ("Preparing signed document"/"Finalizing") and a genuine terminal failure instead
  // of only discovering a stuck render when the signer clicks Submit.
  const [pdfJobStatus, setPdfJobStatus] = useState<string | undefined>(undefined);
  const [pdfJobError, setPdfJobError] = useState<string | null>(null);
  // Raw backend status, distinct from the derived `step` -- both 'signing' and
  // 'signed' map to the same 'upload' step, but the progress copy needs to tell them
  // apart (sign_render vs finalize_certificate is whichever job pdfJobStatus reflects).
  const [sessionStatus, setSessionStatus] = useState('');
  // Only ever holds an entry for a doc actively uploading (with byte progress) or one
  // that just failed client-side/in-flight -- once a doc is confirmed, its state lives
  // in `uploadedDocs` (from the server) instead, so this is cleared for that kind.
  const [uploadStates, setUploadStates] = useState<Record<string, { status: 'uploading' | 'failed'; progress?: number; error?: string }>>({});
  const [removingKind, setRemovingKind] = useState<string | null>(null);
  const uploadedDocKinds = uploadedDocs.map((d) => d.docKind);

  // Bounds how many of the 6 documents can be uploading to Storage at once -- each
  // doc's upload is otherwise fully independent (own state, own request), so nothing
  // else would cap concurrency.
  const activeUploadSlotsRef = useRef(0);
  const uploadSlotWaitersRef = useRef<(() => void)[]>([]);
  const acquireUploadSlot = (): Promise<void> => {
    if (activeUploadSlotsRef.current < MAX_CONCURRENT_UPLOADS) {
      activeUploadSlotsRef.current++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      uploadSlotWaitersRef.current.push(() => {
        activeUploadSlotsRef.current++;
        resolve();
      });
    });
  };
  const releaseUploadSlot = () => {
    activeUploadSlotsRef.current--;
    uploadSlotWaitersRef.current.shift()?.();
  };

  const sessionStorageKey = `nda-step-token-${token}`;

  useEffect(() => {
    if (!token) {
      setStep('error');
      setError('This link is missing required information.');
      return;
    }
    const savedStepToken = sessionStorage.getItem(sessionStorageKey);
    refreshStatus(savedStepToken || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const refreshStatus = async (existingStepToken?: string) => {
    setLoading(true);
    setError('');
    try {
      const data = await invokeEdgeFunction<any>(
        'nda-session-status',
        existingStepToken ? { stepToken: existingStepToken } : { token }
      );

      setSignerName(data.signerName || '');
      setUploadedDocs(data.uploadedDocs || []);
      setPdfJobStatus(data.pdfJobStatus);
      setPdfJobError(data.pdfJobError || null);
      setSessionStatus(data.status || '');

      if (data.status === 'expired') {
        setStep('error');
        setError('This link has expired. Contact your coordinator for a new one.');
        return;
      }

      if (existingStepToken && data.stepTokenValid) {
        setStepToken(existingStepToken);
        setFieldMap(data.templateFieldMap || []);
        setTemplatePdfUrl(data.templatePdfUrl || '');
        setTemplatePageCount(data.templatePageCount || 0);
      }

      if (data.status === 'completed') {
        setStep(existingStepToken && data.stepTokenValid ? 'success' : 'already_done');
      } else if (data.status === 'signing' && !data.pdfJobStatus) {
        // No sign_render job exists for a session already flagged 'signing' --
        // the prior sign attempt was interrupted before the durable job ever got
        // created (see nda-session-submit's handleSign), not a transient timing
        // gap: the job upsert is synchronous within that same call, so if it had
        // succeeded the job would already exist by the time this status check
        // runs. Routing to 'upload' here (like a healthy 'signing' session) would
        // leave the signer stuck polling forever with nothing to show for it --
        // back to 'sign' instead, where submitting again hits handleSign's own
        // recovery path for exactly this state.
        setError('We ran into a problem finishing your last submission. Please review and sign again.');
        setStep(existingStepToken && data.stepTokenValid ? 'sign' : 'send_code');
      } else if (data.status === 'signed' || data.status === 'signing') {
        // 'signing' means the signed PDF is still rendering in the background --
        // uploads are already open against it (see nda-session-upload-url), so this
        // resumes straight to the Upload step exactly like 'signed' rather than
        // falling through to send_code.
        setStep(existingStepToken && data.stepTokenValid ? 'upload' : 'send_code');
      } else if (data.status === 'consented' || data.status === 'otp_verified') {
        setStep(existingStepToken && data.stepTokenValid ? 'sign' : 'send_code');
      } else {
        setStep('send_code');
      }
    } catch (err: any) {
      setStep('error');
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const handleSendCode = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await invokeEdgeFunction<any>('nda-session-send-otp', { token });
      setMaskedEmail(data.maskedEmail);
      setStep('otp');
      resendCooldown.start(30);
    } catch (err: any) {
      // A rejected send still tells us exactly how long is left -- re-sync the
      // visible countdown to it rather than leaving a stale/finished timer next to
      // a "please wait" error.
      const secondsLeft = parseCooldownSeconds(err.message || '');
      if (secondsLeft) resendCooldown.start(secondsLeft);
      setError(err.message || 'Failed to send code');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (otp.length !== 6) return setError('Enter the 6-digit code');
    setLoading(true);
    setError('');
    try {
      const data = await invokeEdgeFunction<any>('nda-session-verify-otp', { token, otp });
      sessionStorage.setItem(sessionStorageKey, data.stepToken);
      setOtp('');
      await refreshStatus(data.stepToken);
    } catch (err: any) {
      setError(err.message || 'Invalid code');
    } finally {
      setLoading(false);
    }
  };

  // The single explicit, audited "I Agree" action: records consent (viewed + agreed)
  // and submits the signature in one call -- both fire from the one button click at
  // the end of the combined document/fields view, regardless of whether this signer
  // is resuming from 'otp_verified' or already 'consented'. The server logs consent,
  // then kicks off the actual signed-PDF rendering in the background and responds
  // immediately, so this resolves quickly and the signer moves straight to Upload
  // without waiting on PDF generation.
  const handleAgreeAndSign = async (signatureDataUrl: string, textValues: Record<string, string>) => {
    setLoading(true);
    setError('');
    try {
      await invokeEdgeFunction('nda-session-submit', {
        action: 'sign', stepToken, viewedToEnd: true, signatureImageBase64: signatureDataUrl, textValues,
      });
      setStep('upload');
    } catch (err: any) {
      setError(err.message || 'Failed to submit signature');
    } finally {
      setLoading(false);
    }
  };

  // Client validates format/size (compressing an oversized image first if possible)
  // before any network call -- a rejected file is never uploaded and then rejected.
  // Multiple doc kinds can be mid-upload at once (see acquireUploadSlot above); one
  // slow/failed document never blocks the others, and a failure here only ever marks
  // this one kind as failed, leaving every other kind's already-confirmed upload intact.
  const handleDocUpload = async (docKind: string, rawFile: File) => {
    setError('');
    setUploadStates((prev) => ({ ...prev, [docKind]: { status: 'uploading', progress: 0 } }));

    const { file, error: prepError } = await prepareDocumentFile(rawFile);
    if (prepError || !file) {
      setUploadStates((prev) => ({ ...prev, [docKind]: { status: 'failed', error: prepError || 'Invalid file' } }));
      return;
    }

    await acquireUploadSlot();
    try {
      // Replacing an already-uploaded document: clear the prior storage object/row first.
      // 'request' mints its signed URL with upsert:false (by design -- see that function),
      // so re-uploading the same doc kind with the same extension would otherwise fail as
      // "already exists"; a different extension would instead silently orphan the old file.
      if (uploadedDocs.some((d) => d.docKind === docKind)) {
        await invokeEdgeFunction('nda-session-upload-url', { stepToken, action: 'remove', docKind });
        setUploadedDocs((prev) => prev.filter((d) => d.docKind !== docKind));
      }

      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      // Hashed client-side so the server never has to download the file just to learn
      // its hash on the response's critical path (see nda-session-upload-url).
      const clientSha256 = await computeFileSha256Hex(file);

      const requestData = await invokeEdgeFunction<{ signedUrl: string; path: string }>('nda-session-upload-url', {
        stepToken, action: 'request', docKind, fileExt: ext,
      });

      await uploadFileWithProgress(requestData.signedUrl, file, file.type || 'application/octet-stream', (percent) => {
        setUploadStates((prev) => ({ ...prev, [docKind]: { status: 'uploading', progress: percent } }));
      });

      await invokeEdgeFunction('nda-session-upload-url', {
        stepToken, action: 'confirm', docKind, path: requestData.path, clientSha256,
      });

      // The server confirms fast and verifies in the background -- reflected here as
      // integrityStatus:'pending', which the poll below picks up and flips to
      // 'verified'/'mismatch' without the signer needing to do anything.
      setUploadedDocs((prev) => [
        ...prev.filter((d) => d.docKind !== docKind),
        { docKind, fileName: file.name, byteSize: file.size, integrityStatus: 'pending' },
      ]);
      setUploadStates((prev) => {
        const next = { ...prev };
        delete next[docKind];
        return next;
      });
    } catch (err: any) {
      setUploadStates((prev) => ({ ...prev, [docKind]: { status: 'failed', error: err.message || 'Upload failed' } }));
    } finally {
      releaseUploadSlot();
    }
  };

  // Background poll while any document is awaiting server-side verification, or the
  // sign_render job is still preparing the signed document -- deliberately its own
  // lightweight call rather than reusing refreshStatus, which toggles the page-wide
  // `loading` flag (used to disable Submit) and would make it flicker every tick.
  // This is what lets the Upload step show real "Preparing signed document"/"Verifying
  // uploads" progress (and a real failure) even before the signer ever clicks Submit,
  // instead of only discovering a stuck render at Finalize time.
  const pdfJobInFlight = pdfJobStatus === 'queued' || pdfJobStatus === 'processing' || pdfJobStatus === 'retrying';
  useEffect(() => {
    if (!stepToken) return;
    const hasPending = uploadedDocs.some((d) => d.integrityStatus === 'pending');
    if (!hasPending && !pdfJobInFlight) return;
    const interval = setInterval(async () => {
      try {
        const data = await invokeEdgeFunction<any>('nda-session-status', { stepToken });
        if (data?.uploadedDocs) setUploadedDocs(data.uploadedDocs);
        setPdfJobStatus(data?.pdfJobStatus);
        setPdfJobError(data?.pdfJobError || null);
      } catch {
        // best-effort -- a transient failure just gets picked up on the next tick
      }
    }, 1500);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadedDocs, stepToken, pdfJobInFlight]);

  // Progress copy for the Upload step, driven entirely off state already being polled
  // above -- "Signature saved" (job not queued/known yet) -> "Preparing signed
  // document" (sign_render in flight) -> "Verifying uploads" (a doc still pending) ->
  // "Finalizing" (finalize_certificate in flight, i.e. after Submit) -> "Completed".
  const uploadProgressLabel = (() => {
    if (pdfJobStatus === 'failed') return null; // shown as a distinct failure state instead
    if (pdfJobInFlight) return sessionStatus === 'signing' ? 'Preparing your signed document…' : 'Finalizing your submission…';
    if (uploadedDocs.some((d) => d.integrityStatus === 'pending')) return 'Verifying uploads…';
    return null;
  })();

  const handleDocRemove = async (docKind: string) => {
    setError('');
    setRemovingKind(docKind);
    try {
      await invokeEdgeFunction('nda-session-upload-url', { stepToken, action: 'remove', docKind });
      setUploadedDocs((prev) => prev.filter((d) => d.docKind !== docKind));
      setUploadStates((prev) => {
        const next = { ...prev };
        delete next[docKind];
        return next;
      });
    } catch (err: any) {
      setError(err.message || 'Failed to remove file');
    } finally {
      setRemovingKind(null);
    }
  };

  const handleDocPreview = async (docKind: string) => {
    setError('');
    try {
      const data = await invokeEdgeFunction<{ url: string }>('nda-session-upload-url', { stepToken, action: 'preview', docKind });
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (err: any) {
      setError(err.message || 'Could not open preview');
    }
  };

  const [finalizing, setFinalizing] = useState<'idle' | 'polling'>('idle');
  // A genuine terminal state (the finalize_certificate job hit max_attempts, or we've
  // been waiting past the ceiling below) -- distinct from the ordinary "still working,
  // keep waiting" case, which never surfaces anything to the signer at all.
  const [finalizeFailure, setFinalizeFailure] = useState<string | null>(null);
  const finalizePollIdRef = useRef(0);

  // Durability now lives in the job table (see nda-session-submit), not in holding
  // this request open or in a client-side retry loop racing the worker -- this polls
  // at the cadence a background job actually completes on: fast at first (2s, since
  // most jobs finish in seconds), then backing off to 5s past 30s, up to a few
  // minutes before treating it as a real stall rather than hammering the backend
  // forever. Each tick reads status first (cheap, and lets a genuine terminal failure
  // stop the loop before ever calling finalize again) and only then nudges finalize --
  // which is idempotent: it no-ops while a job is already in flight and only ever
  // queues a fresh one when none exists or the prior attempt is terminally failed.
  const handleFinalize = async () => {
    setLoading(true);
    setError('');
    setFinalizeFailure(null);
    setFinalizing('polling');
    const pollId = ++finalizePollIdRef.current;
    const startedAt = Date.now();
    const FAST_POLL_MS = 2000;
    const SLOW_POLL_MS = 5000;
    const FAST_POLL_WINDOW_MS = 30_000;
    const CEILING_MS = 4 * 60_000;

    const stop = (fn: () => void) => {
      if (finalizePollIdRef.current !== pollId) return; // superseded by a newer call
      fn();
      setLoading(false);
      setFinalizing('idle');
    };

    const tick = async (): Promise<void> => {
      if (finalizePollIdRef.current !== pollId) return;

      try {
        const status = await invokeEdgeFunction<any>('nda-session-status', { stepToken });
        if (status?.status === 'completed') return stop(() => setStep('success'));
        if (status?.pdfJobStatus === 'failed') {
          return stop(() =>
            setFinalizeFailure(
              status.pdfJobError || 'Something went wrong finishing your submission. Please contact your coordinator.'
            )
          );
        }
        setPdfJobStatus(status?.pdfJobStatus);
        setPdfJobError(status?.pdfJobError || null);
        setSessionStatus(status?.status || '');
      } catch {
        // best-effort -- a transient status read never stops the loop on its own
      }

      if (Date.now() - startedAt >= CEILING_MS) {
        return stop(() =>
          setFinalizeFailure('Still processing your submission. Please check back shortly, or contact your coordinator if this persists.')
        );
      }

      try {
        const data = await invokeEdgeFunction<any>('nda-session-submit', { action: 'finalize', stepToken });
        if (!data?.stillProcessing) return stop(() => setStep('success'));
      } catch (err: any) {
        // A genuine synchronous validation error (missing/mismatched documents) --
        // surface it immediately rather than continuing to poll.
        return stop(() => setError(err.message || 'Failed to submit'));
      }

      if (finalizePollIdRef.current !== pollId) return;
      const elapsed = Date.now() - startedAt;
      await new Promise((resolve) => setTimeout(resolve, elapsed < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS));
      return tick();
    };

    await tick();
  };

  const allDocsUploaded = DOC_ORDER.every((k) => uploadedDocKinds.includes(k));

  const stepIndex =
    step === 'send_code' || step === 'otp' ? 0 : step === 'sign' ? 1 : step === 'upload' ? 2 : step === 'success' ? 3 : -1;
  const baseHeading =
    step === 'send_code'
      ? 'Verify your identity'
      : step === 'otp'
        ? 'Enter your code'
        : step === 'sign'
          ? 'Review & sign'
          : step === 'upload'
            ? 'Upload your documents'
            : 'All done';
  const baseSubtitle =
    step === 'send_code'
      ? "We'll send a one-time code before you can review and sign."
      : step === 'otp'
        ? 'Check your email for the 6-digit verification code.'
        : step === 'sign'
          ? 'Read the agreement and complete every required field.'
          : step === 'upload'
            ? 'A few supporting documents to finish onboarding.'
            : 'Your documents have been signed and submitted.';

  return (
    <PublicPortalFrame
      title="NDA Signing"
      heading={baseHeading}
      subtitle={signerName ? `${signerName} · ${baseSubtitle}` : baseSubtitle}
      steps={NDA_STEPS}
      currentStepIndex={stepIndex}
      wide={step === 'sign'}
    >
        <div className={step === 'sign' ? '' : 'p-8'}>
          {error && (
            <div className={`bg-danger/10 border border-danger/30 rounded-lg p-4 text-danger text-sm ${step === 'sign' ? 'm-4' : 'mb-6'}`}>
              {error}
            </div>
          )}

          {step === 'loading' && (
            <div className="text-center py-8">
              <Loader2 className="w-10 h-10 text-accent mx-auto mb-4 animate-spin" />
              <p className="text-text2">Loading...</p>
            </div>
          )}

          {step === 'error' && (
            <div className="text-center py-8">
              <XCircle className="w-14 h-14 text-danger mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-text mb-2">Unable to continue</h2>
              <p className="text-text2 text-sm">{error}</p>
            </div>
          )}

          {step === 'already_done' && (
            <div className="text-center py-8">
              <CheckCircle2 className="w-14 h-14 text-success mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-text mb-2">Already submitted</h2>
              <p className="text-text2 text-sm">
                Your onboarding documents were already submitted. Contact your coordinator if you need a copy.
              </p>
            </div>
          )}

          {step === 'send_code' && (
            <div className="text-center py-4">
              <Mail className="w-12 h-12 text-accent mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-text mb-2">Verify your identity</h2>
              <p className="text-text2 text-sm mb-6">
                We'll send a one-time verification code to your registered email address before you can review and sign.
              </p>
              <Button variant="primary" onClick={handleSendCode} disabled={loading}>
                {loading ? 'Sending...' : <><Mail className="w-4 h-4" /> Send verification code</>}
              </Button>
            </div>
          )}

          {step === 'otp' && (
            <form onSubmit={handleVerifyOtp}>
              <div className="text-center mb-6">
                <h2 className="text-lg font-semibold text-text mb-2">Enter your code</h2>
                <p className="text-text2 text-sm">
                  We've sent a 6-digit code to <strong className="text-accent">{maskedEmail}</strong>
                </p>
              </div>
              <div className="mb-6">
                <Input
                  type="text"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  maxLength={6}
                  className="text-center text-2xl font-mono font-bold tracking-widest"
                  autoFocus
                />
              </div>
              <div className="flex gap-3">
                <Button type="submit" variant="primary" className="flex-1" disabled={loading || otp.length !== 6}>
                  {loading ? 'Verifying...' : <><CheckCircle2 className="w-4 h-4" /> Verify</>}
                </Button>
                <Button type="button" variant="ghost" onClick={handleSendCode} disabled={loading || resendCooldown.remaining > 0}>
                  <RefreshCw className="w-4 h-4" />
                  {resendCooldown.remaining > 0 ? `Resend in ${resendCooldown.remaining}s` : 'Resend'}
                </Button>
              </div>
            </form>
          )}

          {step === 'sign' && (
            <SignDocumentStep
              templatePdfUrl={templatePdfUrl}
              pageCount={templatePageCount}
              fieldMap={fieldMap}
              signerName={signerName}
              onAgree={handleAgreeAndSign}
              loading={loading}
            />
          )}

          {step === 'upload' && (
            <div>
              <h2 className="text-lg font-semibold text-text mb-2 text-center">Upload your documents</h2>
              <p className="text-text2 text-sm mb-6 text-center">
                Your documents have been signed. Please upload each of the following to finish.
              </p>
              {pdfJobStatus === 'failed' && (
                <div className="bg-danger/10 border border-danger/30 rounded-lg p-4 text-danger text-sm mb-6 text-center">
                  {pdfJobError || 'We ran into a problem preparing your signed document.'} Please contact your coordinator.
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
                {DOC_ORDER.map((kind) => {
                  const serverDoc = uploadedDocs.find((d) => d.docKind === kind);
                  const localState = uploadStates[kind];
                  const isRemoving = removingKind === kind;

                  // Local state (an active upload, or a client-side/network failure) wins
                  // while it's live; otherwise status is derived straight from the
                  // server's record for this doc -- this is also what makes a resumed
                  // session (page refresh mid-verification) render correctly with no
                  // extra bookkeeping.
                  const status: 'idle' | 'uploading' | 'verifying' | 'verified' | 'failed' =
                    localState?.status === 'uploading' || localState?.status === 'failed'
                      ? localState.status
                      : serverDoc
                        ? serverDoc.integrityStatus === 'mismatch'
                          ? 'failed'
                          : serverDoc.integrityStatus === 'verified'
                            ? 'verified'
                            : 'verifying'
                        : 'idle';
                  const canReplaceOrRemove = status !== 'uploading' && !isRemoving;

                  const onFileChosen = (file: File | undefined) => {
                    if (file) handleDocUpload(kind, file);
                  };
                  const onDrop = (e: React.DragEvent<HTMLLabelElement>) => {
                    e.preventDefault();
                    if (!canReplaceOrRemove) return;
                    onFileChosen(e.dataTransfer.files?.[0]);
                  };

                  const DocIcon = DOC_ICONS[kind];
                  // The verified state especially needs to read at a glance across a
                  // grid of 6 cards -- a tinted surface + border does that far better
                  // than the small "Verified" badge alone. A hard failure gets the
                  // same treatment in the danger color so it's equally scannable.
                  const cardStateClass =
                    status === 'verified'
                      ? 'border-success/40 bg-success/5'
                      : status === 'failed'
                        ? 'border-danger/40 bg-danger/5'
                        : 'border-border2 bg-surface2 shadow-sm';

                  return (
                    // Fixed height regardless of state (drop-zone vs. filename row vs. an
                    // error line appearing/disappearing) -- the bottom content block is
                    // anchored to the bottom and clips instead of growing the card, so a
                    // 6-card grid never reflows as files are added/removed/fail.
                    <div key={kind} className={`rounded-lg border p-3.5 transition-colors h-[140px] flex flex-col ${cardStateClass}`}>
                      <div className="flex items-start justify-between gap-3 mb-2 flex-shrink-0">
                        <div className="flex items-center gap-2">
                          <DocIcon className="w-4 h-4 text-text3 flex-shrink-0" />
                          <div className="text-sm font-semibold text-text">{DOC_LABELS[kind]}</div>
                        </div>
                        {status === 'verified' && (
                          <span className="inline-flex items-center gap-1 text-success text-xs font-semibold flex-shrink-0">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Verified
                          </span>
                        )}
                        {status === 'verifying' && (
                          <span className="inline-flex items-center gap-1 text-accent text-xs font-semibold flex-shrink-0">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Verifying
                          </span>
                        )}
                        {status === 'failed' && (
                          <span className="inline-flex items-center gap-1 text-danger text-xs font-semibold flex-shrink-0">
                            <XCircle className="w-3.5 h-3.5" /> Failed
                          </span>
                        )}
                        {status === 'idle' && (
                          <span className="inline-flex items-center gap-1 text-warning text-xs font-semibold flex-shrink-0">
                            Required
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-text3 mb-2 flex-shrink-0">{DOCUMENT_FORMAT_HINT}</div>

                      <div className="flex-1 min-h-0 flex flex-col justify-end gap-1.5 overflow-hidden">
                      {localState?.error && (
                        <div className="text-[11px] text-danger truncate" title={localState.error}>{localState.error}</div>
                      )}

                      {status === 'verifying' || status === 'verified' || (status === 'failed' && serverDoc) ? (
                        <div className="flex items-center justify-between gap-3 bg-surface rounded-md px-2.5 py-2 border border-border">
                          <span className="text-xs text-text2 truncate">
                            {serverDoc && (
                              <>
                                {serverDoc.fileName} <span className="text-text3">({formatFileSize(serverDoc.byteSize)})</span>
                              </>
                            )}
                          </span>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <button
                              className="p-1.5 rounded text-text2 hover:text-accent hover:bg-accent/10 disabled:opacity-40"
                              disabled={!canReplaceOrRemove}
                              onClick={() => handleDocPreview(kind)}
                              title="Preview"
                              aria-label="Preview"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <label
                              className="p-1.5 rounded text-text2 hover:text-accent hover:bg-accent/10 cursor-pointer"
                              title="Replace"
                              aria-label="Replace"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              <input
                                type="file"
                                accept=".pdf,.jpg,.jpeg,.png"
                                className="hidden"
                                disabled={!canReplaceOrRemove}
                                onChange={(e) => {
                                  onFileChosen(e.target.files?.[0]);
                                  e.target.value = '';
                                }}
                              />
                            </label>
                            <button
                              className="p-1.5 rounded text-text2 hover:text-danger hover:bg-danger/10 disabled:opacity-40"
                              disabled={!canReplaceOrRemove}
                              onClick={() => handleDocRemove(kind)}
                              title={isRemoving ? 'Removing…' : 'Remove'}
                              aria-label="Remove"
                            >
                              {isRemoving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <label
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={onDrop}
                          title={status === 'uploading' ? `Uploading ${localState?.progress ?? 0}%` : status === 'failed' ? 'Retry upload' : 'Drop file here or click to browse'}
                          aria-label={status === 'uploading' ? `Uploading ${localState?.progress ?? 0}%` : status === 'failed' ? 'Retry upload' : 'Drop file here or click to browse'}
                          className="flex items-center justify-center gap-1.5 text-xs font-semibold text-accent cursor-pointer border border-dashed border-accent/50 rounded-md py-2 hover:bg-accent/5"
                        >
                          {status === 'uploading' ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Upload className="w-4 h-4" />
                          )}
                          {status === 'uploading' && (
                            <span className="text-[10px]">{localState?.progress ?? 0}%</span>
                          )}
                          <input
                            type="file"
                            accept=".pdf,.jpg,.jpeg,.png"
                            className="hidden"
                            disabled={status === 'uploading'}
                            onChange={(e) => {
                              onFileChosen(e.target.files?.[0]);
                              e.target.value = '';
                            }}
                          />
                        </label>
                      )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {finalizeFailure ? (
                <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-center">
                  <XCircle className="w-8 h-8 text-danger mx-auto mb-2" />
                  <p className="text-sm text-danger mb-3">{finalizeFailure}</p>
                  <Button variant="primary" onClick={() => handleFinalize()} disabled={loading}>
                    <RefreshCw className="w-4 h-4" /> Try again
                  </Button>
                </div>
              ) : (
                <>
                  {(finalizing === 'polling' ? (sessionStatus === 'signed' ? 'Finalizing your submission…' : uploadProgressLabel) : uploadProgressLabel) && (
                    <p className="text-xs text-text3 text-center mb-2 flex items-center justify-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {finalizing === 'polling' ? 'Finalizing your submission…' : uploadProgressLabel}
                    </p>
                  )}
                  <Button variant="success" className="w-full" onClick={() => handleFinalize()} disabled={!allDocsUploaded || loading}>
                    {finalizing === 'polling' ? 'Finalizing…' : loading ? 'Submitting...' : <><CheckCircle2 className="w-4 h-4" /> Submit All Documents</>}
                  </Button>
                </>
              )}
            </div>
          )}

          {step === 'success' && (
            <div className="text-center py-8">
              <PartyPopper className="w-16 h-16 text-accent mx-auto mb-6" />
              <h2 className="text-2xl font-bold text-text mb-3">All done!</h2>
              <p className="text-text2 mb-6">
                Your documents have been signed and submitted. Our team will review everything and be in touch.
              </p>
              <div className="bg-success/10 border border-success/30 rounded-lg p-4 text-sm text-success flex items-center justify-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> Submission complete
              </div>
            </div>
          )}
        </div>
    </PublicPortalFrame>
  );
}

interface Slot {
  id: string;
  kind: 'signature' | 'text';
  label?: string;
  fieldKey: string;
}

function SignDocumentStep({
  templatePdfUrl,
  pageCount,
  fieldMap,
  signerName,
  onAgree,
  loading,
}: {
  templatePdfUrl: string;
  pageCount: number;
  fieldMap: TemplateField[];
  signerName: string;
  onAgree: (signatureDataUrl: string, textValues: Record<string, string>) => void;
  loading: boolean;
}) {
  // Rendering all pages up front doesn't scale -- this document runs to hundreds of
  // pages, and most of them (internal reference policies with no fields) the signer
  // never needs to look at. Pages render lazily, one at a time, only once their
  // placeholder scrolls near the viewport -- the same approach any PDF viewer uses for
  // large documents. Rendered pages are cached in state and never re-rendered.
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [pageImages, setPageImages] = useState<Record<number, string>>({});
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const [modalOpen, setModalOpen] = useState(false);
  // Every individual signature placement is its own required stop -- the signer must
  // see and explicitly confirm each one (per live-testing feedback: the old design
  // treated "signature" as one slot and silently stamped the same image onto every
  // occurrence, so Next finished after just the first one, without the signer ever
  // seeing the other 8 placements in this document). The captured image itself is
  // still shared across all of them (nda-session-submit only accepts one signature
  // image), but confirming each location is a distinct, visible, explicit action.
  const [confirmedSignatureKeys, setConfirmedSignatureKeys] = useState<Set<string>>(new Set());
  const [pendingSignatureFieldKey, setPendingSignatureFieldKey] = useState<string | null>(null);
  const [showFinalConfirm, setShowFinalConfirm] = useState(false);
  const slotRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pagePlaceholderRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const renderingRef = useRef<Set<number>>(new Set());
  const todayDisplay = useMemo(() => formatIstDateDisplay(new Date()), []);

  // Loading the document itself (parsing structure) is fast -- it's rendering every
  // page to a canvas that's expensive, and that now only happens on demand below.
  useEffect(() => {
    if (!templatePdfUrl) return;
    let cancelled = false;
    pdfjsLib.getDocument({ url: templatePdfUrl }).promise.then((doc) => {
      if (!cancelled) setPdfDoc(doc);
    });
    return () => {
      cancelled = true;
    };
  }, [templatePdfUrl]);

  const renderPageImpl = async (pageIndex: number) => {
    if (!pdfDoc || pageImages[pageIndex] || renderingRef.current.has(pageIndex)) return;
    renderingRef.current.add(pageIndex);
    try {
      const page = await pdfDoc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1.4 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvas, viewport }).promise;
      const src = canvas.toDataURL('image/png');
      setPageImages((prev) => ({ ...prev, [pageIndex]: src }));
    } finally {
      renderingRef.current.delete(pageIndex);
    }
  };
  const renderPageRef = useRef(renderPageImpl);
  renderPageRef.current = renderPageImpl;

  useEffect(() => {
    if (!pdfDoc) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
            renderPageRef.current(idx);
          }
        }
      },
      // root:null (the viewport) -- the actual scrolling ancestor is now
      // PublicPortalFrame's content pane (this step no longer owns its own
      // scroll region), which this component has no ref to. The frame fills
      // nearly the full viewport, so viewport-relative intersection is an
      // accurate enough proxy.
      { root: null, rootMargin: '800px 0px', threshold: 0.01 }
    );
    Object.values(pagePlaceholderRefs.current).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [pdfDoc]);

  // Used by "Next" to jump straight to a field even if its page hasn't rendered yet.
  // Only auto-opens the signature modal the first time ever (no captured image yet) --
  // once a signature exists, later placements are already previewed on the page and
  // just need a click to confirm, not a re-draw.
  const scrollToSlot = (id: string, kind: 'signature' | 'text', fieldKey: string) => {
    let attempts = 0;
    const tryScroll = () => {
      const el = slotRefs.current[id];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (kind === 'signature') {
          if (!signatureDataUrl) {
            setPendingSignatureFieldKey(fieldKey);
            setModalOpen(true);
          }
        } else {
          window.setTimeout(() => (el.querySelector('input') as HTMLInputElement | null)?.focus(), 350);
        }
      } else if (attempts < 40) {
        attempts += 1;
        window.setTimeout(tryScroll, 50);
      }
    };
    tryScroll();
  };

  // Every signature field is its own required slot -- the signer must see and
  // explicitly confirm each individual placement (see confirmedSignatureKeys above).
  // Text fields stay grouped by label: the 2 "Address" fields in this document sit
  // side by side on the same page, so visiting one already shows both on screen.
  // full_name/date are known from the verified session already and shown read-only,
  // not as additional required slots.
  const slots = useMemo(() => {
    const sorted = [...fieldMap].sort((a, b) => a.page_index - b.page_index || a.y - b.y);
    const result: Slot[] = [];
    const seenLabels = new Set<string>();
    for (const f of sorted) {
      if (f.kind === 'signature') {
        result.push({ id: f.field_key, kind: 'signature', fieldKey: f.field_key });
      }
      if (f.kind === 'text' && f.label && !seenLabels.has(f.label)) {
        seenLabels.add(f.label);
        result.push({ id: `text:${f.label}`, kind: 'text', label: f.label, fieldKey: f.field_key });
      }
    }
    return result;
  }, [fieldMap]);

  const isSlotDone = (slot: Slot) =>
    slot.kind === 'signature' ? confirmedSignatureKeys.has(slot.fieldKey) : !!textValues[slot.label!]?.trim();
  const remaining = slots.filter((s) => !isSlotDone(s));
  const allDone = slots.length > 0 && remaining.length === 0;
  const remainingSignatureSlots = slots.filter((s) => s.kind === 'signature' && !confirmedSignatureKeys.has(s.fieldKey));

  const goToNext = () => {
    const target = remaining[0];
    if (!target) return;
    const field = fieldMap.find((f) => f.field_key === target.fieldKey);
    if (field) void renderPageRef.current(field.page_index);
    scrollToSlot(target.id, target.kind, target.fieldKey);
  };

  const useSignatureEverywhere = () => {
    setConfirmedSignatureKeys((prev) => {
      const next = new Set(prev);
      remainingSignatureSlots.forEach((s) => next.add(s.fieldKey));
      return next;
    });
  };

  return (
    <div>
      <div className="sticky top-0 z-10 bg-surface border-b border-border px-5 py-3 flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-text2">
          {allDone ? 'All required fields complete' : `${remaining.length} required field${remaining.length === 1 ? '' : 's'} left`}
        </span>
        {allDone ? (
          <Button
            variant="success"
            onClick={() => setShowFinalConfirm(true)}
            disabled={loading}
          >
            {loading ? 'Submitting...' : <><CheckCircle2 className="w-4 h-4" /> I Agree — Sign &amp; Continue</>}
          </Button>
        ) : (
          <Button variant="primary" onClick={goToNext} disabled={slots.length === 0}>
            Next →
          </Button>
        )}
      </div>

      {allDone && (
        <div className="mx-5 mt-3 bg-success/10 border border-success/30 rounded-lg px-4 py-2.5 text-success text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          You've completed every required field. Review the document below, then click "I Agree" to sign.
        </div>
      )}

      {!allDone && signatureDataUrl && remainingSignatureSlots.length > 0 && (
        <div className="mx-5 mt-3 bg-accent/10 border border-accent/30 rounded-lg px-4 py-2.5 text-sm flex items-center justify-between gap-3">
          <span className="text-text2">
            You still have {remainingSignatureSlots.length} more signature {remainingSignatureSlots.length === 1 ? 'spot' : 'spots'} to confirm.
          </span>
          <Button variant="ghost" size="sm" onClick={useSignatureEverywhere} className="!text-[11px] whitespace-nowrap">
            Use this signature everywhere
          </Button>
        </div>
      )}

      <div className="p-5 bg-surface2">
        {!pdfDoc ? (
          <div className="text-center py-12 text-text3 text-sm flex flex-col items-center gap-2">
            <Loader2 className="w-6 h-6 animate-spin" /> Loading document ({pageCount} page{pageCount === 1 ? '' : 's'})...
          </div>
        ) : (
          Array.from({ length: pageCount }, (_, pIdx) => {
            const src = pageImages[pIdx];
            return (
            <div
              key={pIdx}
              ref={(el) => { pagePlaceholderRefs.current[pIdx] = el; }}
              data-page-index={pIdx}
              className="relative mb-3 rounded border border-border mx-auto block overflow-hidden bg-white"
              style={src ? undefined : { aspectRatio: '210 / 297', minHeight: 200 }}
            >
              {src ? (
                <img src={src} className="w-full block" alt={`Document page ${pIdx + 1}`} />
              ) : (
                <div className="flex items-center justify-center h-full text-text3 text-xs py-24">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" /> Page {pIdx + 1}
                </div>
              )}
              {src && fieldMap
                .filter((f) => f.page_index === pIdx)
                .map((f) => {
                  const style: React.CSSProperties = {
                    position: 'absolute',
                    left: `${f.x * 100}%`,
                    top: `${f.y * 100}%`,
                    width: `${f.w * 100}%`,
                    height: `${f.h * 100}%`,
                  };

                  if (f.kind === 'full_name' || f.kind === 'date') {
                    return (
                      <div
                        key={f.field_key}
                        style={style}
                        className="flex items-center px-1 bg-accent/5 border border-accent/30 rounded-sm text-[11px] text-slate-700 font-medium overflow-hidden whitespace-nowrap"
                      >
                        {f.kind === 'full_name' ? signerName : todayDisplay}
                      </div>
                    );
                  }

                  if (f.kind === 'signature') {
                    const isConfirmed = confirmedSignatureKeys.has(f.field_key);
                    return (
                      <div
                        key={f.field_key}
                        ref={(el) => { slotRefs.current[f.field_key] = el; }}
                        style={style}
                        onClick={() => {
                          if (!signatureDataUrl) {
                            setPendingSignatureFieldKey(f.field_key);
                            setModalOpen(true);
                          } else if (!isConfirmed) {
                            setConfirmedSignatureKeys((prev) => new Set(prev).add(f.field_key));
                          } else {
                            // Already confirmed -- clicking again lets them redo the drawing/typing.
                            setPendingSignatureFieldKey(f.field_key);
                            setModalOpen(true);
                          }
                        }}
                        className={`flex items-center justify-center rounded-sm cursor-pointer transition-colors relative ${
                          !signatureDataUrl
                            ? 'bg-warning/10 border-2 border-dashed border-warning'
                            : isConfirmed
                              ? 'bg-white border border-success'
                              : 'bg-white border-2 border-dashed border-accent'
                        }`}
                      >
                        {signatureDataUrl ? (
                          <>
                            <img src={signatureDataUrl} className="max-w-full max-h-full object-contain" alt="Your signature" />
                            {!isConfirmed && (
                              <span className="absolute inset-x-0 -bottom-4 text-center text-[9px] font-semibold text-accent whitespace-nowrap">
                                Click to confirm
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-[10px] font-semibold text-warning">Click to sign</span>
                        )}
                      </div>
                    );
                  }

                  if (f.kind === 'text' && f.label) {
                    const slotId = `text:${f.label}`;
                    const isFirst = slots.find((s) => s.id === slotId)?.fieldKey === f.field_key;
                    return (
                      <div
                        key={f.field_key}
                        ref={isFirst ? (el) => { slotRefs.current[slotId] = el; } : undefined}
                        style={style}
                      >
                        <input
                          value={textValues[f.label] || ''}
                          onChange={(e) => setTextValues((v) => ({ ...v, [f.label!]: e.target.value }))}
                          placeholder={f.label}
                          className="w-full h-full px-1 text-[11px] bg-white text-slate-900 placeholder:text-slate-400 border border-accent rounded-sm outline-none focus:ring-1 focus:ring-accent"
                        />
                      </div>
                    );
                  }

                  return null;
                })}
            </div>
            );
          })
        )}
      </div>

      {modalOpen && (
        <SignatureModal
          signerName={signerName}
          onClose={() => {
            setModalOpen(false);
            setPendingSignatureFieldKey(null);
          }}
          onCapture={(dataUrl) => {
            setSignatureDataUrl(dataUrl);
            if (pendingSignatureFieldKey) {
              setConfirmedSignatureKeys((prev) => new Set(prev).add(pendingSignatureFieldKey));
            }
            setModalOpen(false);
            setPendingSignatureFieldKey(null);
          }}
        />
      )}

      {showFinalConfirm && (
        <Modal isOpen={true} onClose={() => setShowFinalConfirm(false)} title="Confirm your signature">
          <div>
            <p className="text-sm text-text2 mb-4">
              You're about to sign as <span className="font-semibold text-text">{signerName}</span> on{' '}
              <span className="font-semibold text-text">{todayDisplay}</span>. All {slots.length} required field
              {slots.length === 1 ? '' : 's'} have been completed. This action is final and cannot be undone.
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-border">
              <Button variant="ghost" onClick={() => setShowFinalConfirm(false)} disabled={loading}>Cancel</Button>
              <Button
                variant="success"
                onClick={() => {
                  setShowFinalConfirm(false);
                  onAgree(signatureDataUrl!, textValues);
                }}
                disabled={loading}
              >
                {loading ? 'Submitting...' : <><CheckCircle2 className="w-4 h-4" /> Confirm &amp; Sign</>}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SignatureModal({
  signerName,
  onClose,
  onCapture,
}: {
  signerName: string;
  onClose: () => void;
  onCapture: (dataUrl: string) => void;
}) {
  const [tab, setTab] = useState<'draw' | 'type' | 'upload'>('draw');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [typedName, setTypedName] = useState(signerName || '');
  const [fontIndex, setFontIndex] = useState(0);
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState('');

  const handleUploadFile = (file: File) => {
    setUploadError('');
    if (!file.type.startsWith('image/')) {
      setUploadError('Please choose an image file (PNG or JPG).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 500;
        canvas.height = 160;
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        setUploadedImage(canvas.toDataURL('image/png'));
      };
      img.onerror = () => setUploadError('Could not read that image. Please try another file.');
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const getPos = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const point = 'touches' in e ? e.touches[0] : e;
    // The canvas's CSS size (rect.width/height, stretched to fit the modal via
    // w-full) rarely matches its fixed 500x160 drawing-resolution -- especially
    // on mobile, where the modal is much narrower -- so a raw pixel offset would
    // land in the wrong spot. Scale into the canvas's own coordinate space.
    return {
      x: ((point.clientX - rect.left) * canvas.width) / rect.width,
      y: ((point.clientY - rect.top) * canvas.height) / rect.height,
    };
  };
  const startDraw = (e: React.MouseEvent | React.TouchEvent) => {
    drawingRef.current = true;
    const ctx = canvasRef.current!.getContext('2d')!;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    setHasDrawn(true);
  };
  const endDraw = () => {
    drawingRef.current = false;
  };
  const clear = () => {
    const canvas = canvasRef.current!;
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawn(false);
  };

  const canInsert =
    tab === 'draw' ? hasDrawn :
    tab === 'upload' ? !!uploadedImage :
    typedName.trim().length > 0;

  const handleInsert = () => {
    if (tab === 'draw') {
      onCapture(canvasRef.current!.toDataURL('image/png'));
      return;
    }
    if (tab === 'upload') {
      if (uploadedImage) onCapture(uploadedImage);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 160;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111827';
    ctx.font = `48px ${SIGNATURE_FONTS[fontIndex]}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(typedName.trim(), canvas.width / 2, canvas.height / 2);
    onCapture(canvas.toDataURL('image/png'));
  };

  return (
    <Modal isOpen={true} onClose={onClose} title="Add your signature">
      <div>
        <div className="flex gap-2 mb-4">
          <button
            type="button"
            onClick={() => setTab('draw')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold border ${tab === 'draw' ? 'bg-accent text-white border-accent' : 'border-border text-text2'}`}
          >
            <PenLine className="w-3.5 h-3.5" /> Draw
          </button>
          <button
            type="button"
            onClick={() => setTab('type')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold border ${tab === 'type' ? 'bg-accent text-white border-accent' : 'border-border text-text2'}`}
          >
            <TypeIcon className="w-3.5 h-3.5" /> Type
          </button>
          <button
            type="button"
            onClick={() => setTab('upload')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold border ${tab === 'upload' ? 'bg-accent text-white border-accent' : 'border-border text-text2'}`}
          >
            <Upload className="w-3.5 h-3.5" /> Upload
          </button>
        </div>

        {tab === 'draw' && (
          <>
            <div className="border-2 border-dashed border-border rounded-lg mb-2 bg-white">
              <canvas
                ref={canvasRef}
                width={500}
                height={160}
                className="w-full touch-none cursor-crosshair"
                onMouseDown={startDraw}
                onMouseMove={draw}
                onMouseUp={endDraw}
                onMouseLeave={endDraw}
                onTouchStart={startDraw}
                onTouchMove={draw}
                onTouchEnd={endDraw}
              />
            </div>
            <div className="flex justify-end mb-4">
              <Button variant="ghost" size="sm" onClick={clear}>
                <Eraser className="w-3.5 h-3.5" /> Clear
              </Button>
            </div>
          </>
        )}

        {tab === 'type' && (
          <>
            <div className="mb-3">
              <Input value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder="Type your full name" autoFocus />
            </div>
            <div
              className="border border-border rounded-lg bg-white h-[160px] flex items-center justify-center mb-2 px-4"
              style={{ fontFamily: SIGNATURE_FONTS[fontIndex] }}
            >
              <span className={`text-4xl truncate max-w-full ${typedName.trim() ? 'text-slate-900' : 'text-slate-400'}`}>
                {typedName.trim() || 'Your Name'}
              </span>
            </div>
            <div className="flex justify-end mb-4">
              <Button variant="ghost" size="sm" onClick={() => setFontIndex((i) => (i + 1) % SIGNATURE_FONTS.length)}>
                <RefreshCw className="w-3.5 h-3.5" /> Change font
              </Button>
            </div>
          </>
        )}

        {tab === 'upload' && (
          <>
            <label className="border-2 border-dashed border-border rounded-lg mb-2 bg-white h-[160px] flex items-center justify-center cursor-pointer overflow-hidden">
              {uploadedImage ? (
                <img src={uploadedImage} alt="Uploaded signature preview" className="max-h-full max-w-full object-contain" />
              ) : (
                <span className="text-xs text-text3 flex flex-col items-center gap-1.5">
                  <Upload className="w-5 h-5" /> Click to choose an image
                </span>
              )}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleUploadFile(file);
                }}
              />
            </label>
            {uploadError && <p className="text-[11px] text-danger mb-2">{uploadError}</p>}
            {uploadedImage && (
              <div className="flex justify-end mb-4">
                <Button variant="ghost" size="sm" onClick={() => setUploadedImage(null)}>
                  <Eraser className="w-3.5 h-3.5" /> Remove
                </Button>
              </div>
            )}
            {!uploadedImage && <div className="mb-4" />}
          </>
        )}

        <p className="text-[11px] text-text3 mb-4">I understand this is a legal representation of my signature.</p>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleInsert} disabled={!canInsert}>Insert</Button>
        </div>
      </div>
    </Modal>
  );
}
