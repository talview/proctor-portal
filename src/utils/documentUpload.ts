// Shared client-side helpers for document upload flows (BGV bulk/single upload in
// IncompletePage, and the candidate-facing onboarding upload in NdaSignPage): file
// size/format validation, client-side image compression, SHA-256 hashing, an XHR-based
// upload with byte-level progress, and a small bounded-concurrency pool. Centralized here
// so both flows enforce identical limits and behave identically rather than drifting.

export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024; // 3MB, per the standard upload limit
export const ALLOWED_DOCUMENT_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png'];
const ALLOWED_DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

export const DOCUMENT_SIZE_ERROR_MESSAGE = 'File exceeds the 3 MB maximum size. Please compress the file and try again.';
export const DOCUMENT_FORMAT_HINT = 'PDF, JPG or PNG • Maximum 3 MB';

export function validateDocumentFormat(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  // Some browsers/OSes leave `file.type` empty for certain sources (e.g. some camera
  // uploads) -- only reject on a mime type that's actually present and wrong, never on
  // an absent one, so a valid file isn't rejected on a missing browser-supplied hint.
  const mimeOk = !file.type || ALLOWED_DOCUMENT_MIME_TYPES.includes(file.type);
  if (!ALLOWED_DOCUMENT_EXTENSIONS.includes(ext) || !mimeOk) {
    return 'Only PDF, JPG, or PNG files are accepted.';
  }
  return null;
}

/**
 * Re-encodes an oversized JPG/PNG at a lower quality/scale (never below quality 0.5)
 * until it fits under `maxBytes`, preserving readability rather than silently mangling
 * text/IDs. Returns the original file unchanged if it's not an image, already fits, or
 * compression can't bring it under the limit (the caller then rejects with the standard
 * "exceeds 3MB" message rather than uploading a file that failed to compress).
 */
export async function compressImageIfNeeded(file: File, maxBytes: number): Promise<File> {
  if (!file.type.startsWith('image/') || file.size <= maxBytes) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // can't decode client-side -- let server-side validation reject it
  }

  let quality = 0.85;
  let scale = 1;
  let bestBlob: Blob | null = null;

  for (let attempt = 0; attempt < 8; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob) {
      bestBlob = blob;
      if (blob.size <= maxBytes) break;
    }
    // Tighten quality first; only shrink dimensions once quality is already low, so
    // text/IDs stay as legible as possible for as long as possible.
    if (quality > 0.5) quality -= 0.12;
    else scale *= 0.75;
  }

  bitmap.close();
  if (!bestBlob || bestBlob.size > maxBytes) return file;

  const newName = file.name.replace(/\.\w+$/, '') + '.jpg';
  return new File([bestBlob], newName, { type: 'image/jpeg' });
}

/**
 * Validates format, compresses an oversized image if possible, and enforces the 3MB
 * limit -- all before any network call, so a rejected file is never uploaded first and
 * rejected afterward.
 */
export async function prepareDocumentFile(file: File): Promise<{ file: File | null; error: string | null }> {
  const formatError = validateDocumentFormat(file);
  if (formatError) return { file: null, error: formatError };

  let candidate = file;
  if (candidate.size > MAX_DOCUMENT_BYTES) {
    candidate = await compressImageIfNeeded(candidate, MAX_DOCUMENT_BYTES);
  }
  if (candidate.size > MAX_DOCUMENT_BYTES) {
    return { file: null, error: DOCUMENT_SIZE_ERROR_MESSAGE };
  }
  return { file: candidate, error: null };
}

export async function computeFileSha256Hex(file: File | Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PUT via XHR (not fetch) specifically to get byte-level upload progress. */
export function uploadFileWithProgress(
  url: string,
  file: File | Blob,
  contentType: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType || 'application/octet-stream');
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error('Upload failed, please try again'));
    };
    xhr.onerror = () => reject(new Error('Upload failed, please try again'));
    xhr.send(file);
  });
}

// Re-exported for existing importers -- moved to its own module since it's now also
// used outside the document-upload flow (see src/utils/concurrency.ts).
export { runWithConcurrency } from './concurrency';

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
