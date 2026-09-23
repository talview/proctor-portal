import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateAge } from '@/utils/age';

describe('calculateAge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is exactly 18 on the 18th birthday itself', () => {
    expect(calculateAge('2008-09-13')).toBe(18);
  });

  it('is still 17 the day before the 18th birthday', () => {
    expect(calculateAge('2008-09-14')).toBe(17);
  });

  it('is 18 the day after the 18th birthday', () => {
    expect(calculateAge('2008-09-12')).toBe(18);
  });

  it('is 0 for a birth date of today', () => {
    expect(calculateAge('2026-09-13')).toBe(0);
  });

  it('handles a standard adult date of birth', () => {
    expect(calculateAge('1994-08-13')).toBe(32);
  });

  it('handles the loose M/D/YY format found in historical CSV-imported data', () => {
    expect(calculateAge('8/13/94')).toBe(32);
  });

  it('returns NaN for an unparseable date instead of a false age', () => {
    expect(Number.isNaN(calculateAge('not-a-date'))).toBe(true);
  });

  it('returns NaN for an empty string', () => {
    expect(Number.isNaN(calculateAge(''))).toBe(true);
  });

  it('returns NaN for whitespace-only input', () => {
    expect(Number.isNaN(calculateAge('   '))).toBe(true);
  });
});
