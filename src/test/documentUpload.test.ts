import { describe, it, expect } from 'vitest';
import {
  MAX_DOCUMENT_BYTES,
  DOCUMENT_SIZE_ERROR_MESSAGE,
  validateDocumentFormat,
  prepareDocumentFile,
  runWithConcurrency,
  formatFileSize,
} from '@/utils/documentUpload';

function makeFile(name: string, size: number, type: string): File {
  const bytes = new Uint8Array(size);
  return new File([bytes], name, { type });
}

describe('validateDocumentFormat', () => {
  it('accepts pdf/jpg/jpeg/png with a matching mime type', () => {
    expect(validateDocumentFormat(makeFile('a.pdf', 100, 'application/pdf'))).toBeNull();
    expect(validateDocumentFormat(makeFile('a.jpg', 100, 'image/jpeg'))).toBeNull();
    expect(validateDocumentFormat(makeFile('a.jpeg', 100, 'image/jpeg'))).toBeNull();
    expect(validateDocumentFormat(makeFile('a.png', 100, 'image/png'))).toBeNull();
  });

  it('accepts a file with no browser-supplied mime type, based on extension alone', () => {
    expect(validateDocumentFormat(makeFile('a.pdf', 100, ''))).toBeNull();
  });

  it('rejects an unsupported extension', () => {
    expect(validateDocumentFormat(makeFile('a.docx', 100, 'application/msword'))).toMatch(/PDF, JPG, or PNG/);
  });

  it('rejects a browser-reported mime type outside the allow-list', () => {
    expect(validateDocumentFormat(makeFile('a.pdf', 100, 'text/plain'))).toMatch(/PDF, JPG, or PNG/);
  });
});

describe('prepareDocumentFile', () => {
  it('passes through a small valid file unchanged', async () => {
    const file = makeFile('resume.pdf', 1024, 'application/pdf');
    const { file: prepared, error } = await prepareDocumentFile(file);
    expect(error).toBeNull();
    expect(prepared).toBe(file);
  });

  it('rejects an invalid format before checking size', async () => {
    const file = makeFile('resume.docx', 10, 'application/msword');
    const { file: prepared, error } = await prepareDocumentFile(file);
    expect(prepared).toBeNull();
    expect(error).toMatch(/PDF, JPG, or PNG/);
  });

  it('rejects an oversized non-image file with the standard message (no compression possible)', async () => {
    const file = makeFile('resume.pdf', MAX_DOCUMENT_BYTES + 1, 'application/pdf');
    const { file: prepared, error } = await prepareDocumentFile(file);
    expect(prepared).toBeNull();
    expect(error).toBe(DOCUMENT_SIZE_ERROR_MESSAGE);
  });
});

describe('runWithConcurrency', () => {
  it('runs every item and preserves per-index results including failures', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWithConcurrency(items, 2, async (n) => {
      if (n === 3) throw new Error('boom');
      return n * 10;
    });
    expect(results).toEqual([
      { status: 'fulfilled', value: 10 },
      { status: 'fulfilled', value: 20 },
      { status: 'rejected', reason: new Error('boom') },
      { status: 'fulfilled', value: 40 },
      { status: 'fulfilled', value: 50 },
    ]);
  });

  it('never runs more than `limit` workers concurrently', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let active = 0;
    let maxActive = 0;
    await runWithConcurrency(items, 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('one item failing does not stop the others from completing', async () => {
    const items = [1, 2, 3];
    const completed: number[] = [];
    await runWithConcurrency(items, 3, async (n) => {
      if (n === 1) throw new Error('fails immediately');
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed.push(n);
    });
    expect(completed.sort()).toEqual([2, 3]);
  });
});

describe('formatFileSize', () => {
  it('formats sub-1MB sizes in KB', () => {
    expect(formatFileSize(2048)).toBe('2KB');
  });
  it('formats 1MB+ sizes in MB', () => {
    expect(formatFileSize(1.8 * 1024 * 1024)).toBe('1.8MB');
  });
});
