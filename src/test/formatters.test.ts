import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatDate, formatDateTime, formatRelativeTime, formatPhone, aadhaarStatus, getInitials, exportToCSV } from '@/utils/formatters';

describe('formatDate', () => {
  it('returns — for null', () => {
    expect(formatDate(null)).toBe('—');
  });
  it('returns — for undefined', () => {
    expect(formatDate(undefined)).toBe('—');
  });
  it('returns — for empty string', () => {
    expect(formatDate('')).toBe('—');
  });
  it('formats a valid ISO date', () => {
    const result = formatDate('2024-01-15');
    expect(result).toMatch(/15 Jan 2024/);
  });
  it('returns — for invalid date string', () => {
    expect(formatDate('not-a-date')).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('returns — for null', () => {
    expect(formatDateTime(null)).toBe('—');
  });
  it('returns — for undefined', () => {
    expect(formatDateTime(undefined)).toBe('—');
  });
  it('formats a valid ISO datetime', () => {
    const result = formatDateTime('2024-01-15T10:30:00');
    expect(result).toMatch(/15 Jan 2024/);
    expect(result).toMatch(/10:30/);
  });
});

describe('formatRelativeTime', () => {
  it('returns — for null', () => {
    expect(formatRelativeTime(null)).toBe('—');
  });
  it('returns — for undefined', () => {
    expect(formatRelativeTime(undefined)).toBe('—');
  });
  it('returns a relative string for a recent date', () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    const result = formatRelativeTime(recent);
    expect(result).toMatch(/ago/);
  });
});

describe('formatPhone', () => {
  it('returns — for null', () => {
    expect(formatPhone(null)).toBe('—');
  });
  it('returns — for undefined', () => {
    expect(formatPhone(undefined)).toBe('—');
  });
  it('formats a 10-digit phone with space', () => {
    const result = formatPhone('9876543210');
    expect(result).toBe('98765 43210');
  });
  it('returns raw phone for non-10-digit', () => {
    expect(formatPhone('123')).toBe('123');
  });
  it('returns raw phone for 11-digit number', () => {
    expect(formatPhone('91987654321')).toBe('91987654321');
  });
});

describe('aadhaarStatus', () => {
  it('returns not-provided for null', () => {
    expect(aadhaarStatus(null)).toBe('Not provided yet');
  });
  it('returns not-provided for undefined', () => {
    expect(aadhaarStatus(undefined)).toBe('Not provided yet');
  });
  it('returns not-provided for a PENDING_ placeholder', () => {
    expect(aadhaarStatus('PENDING_abc123')).toBe('Not provided yet');
  });
  it('never reveals the stored hash, just presence', () => {
    expect(aadhaarStatus('a'.repeat(64))).toBe('On file');
  });
});

describe('getInitials', () => {
  it('returns initials for full name', () => {
    expect(getInitials('John Doe')).toBe('JD');
  });
  it('returns single initial for single name', () => {
    expect(getInitials('John')).toBe('J');
  });
  it('returns max 2 initials', () => {
    expect(getInitials('John Michael Doe')).toBe('JM');
  });
  it('returns uppercase initials', () => {
    expect(getInitials('alice bob')).toBe('AB');
  });
});

describe('exportToCSV', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing for empty data', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    exportToCSV([], 'test');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('triggers download for non-empty data', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el);
    vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    const data = [{ name: 'John', age: 30 }];
    exportToCSV(data, 'test_export');

    expect(URL.createObjectURL).toHaveBeenCalled();
    appendSpy.mockRestore();
  });

  it('properly quotes values with commas', () => {
    // Capture the content passed to Blob constructor rather than reading from the Blob
    let capturedContent = '';
    const OrigBlob = globalThis.Blob;
    globalThis.Blob = class extends OrigBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        if (parts) capturedContent = parts.join('');
      }
    } as typeof Blob;

    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el);
    vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    const data = [{ name: 'Doe, John', city: 'New York' }];
    exportToCSV(data, 'test');

    globalThis.Blob = OrigBlob;
    expect(capturedContent).toContain('"Doe, John"');
  });

  it('properly quotes values with double quotes', () => {
    let capturedContent = '';
    const OrigBlob = globalThis.Blob;
    globalThis.Blob = class extends OrigBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        if (parts) capturedContent = parts.join('');
      }
    } as typeof Blob;

    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el);
    vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    const data = [{ name: 'He said "hello"', city: 'Delhi' }];
    exportToCSV(data, 'test');

    globalThis.Blob = OrigBlob;
    expect(capturedContent).toContain('"He said ""hello"""');
  });
});
