import { describe, it, expect } from 'vitest';
import { getScopedVendor, isVendorScoped } from '@/utils/access';
import type { User } from '@/types';

const makeUser = (role: User['role'], vendor?: User['vendor']): User => ({
  id: '1', username: 'test', name: 'Test', email: 'test@test.com',
  role, vendor, created_at: '', updated_at: '', mustChangePassword: false,
});

describe('getScopedVendor', () => {
  it('returns undefined for admin', () => {
    expect(getScopedVendor(makeUser('admin'))).toBeUndefined();
  });
  it('returns undefined for coordinator (no vendor assigned)', () => {
    expect(getScopedVendor(makeUser('coordinator'))).toBeUndefined();
  });
  it('returns vendor for vendor role', () => {
    expect(getScopedVendor(makeUser('vendor', 'Sai'))).toBe('Sai');
  });
  it('returns undefined for null user', () => {
    expect(getScopedVendor(null)).toBeUndefined();
  });
  it('returns undefined for undefined user', () => {
    expect(getScopedVendor(undefined)).toBeUndefined();
  });
  it('returns vendor string for each valid vendor', () => {
    const vendors: User['vendor'][] = ['Sai', 'TSN', 'Avner', 'A&M', 'ATS', 'Awign'];
    vendors.forEach(vendor => {
      expect(getScopedVendor(makeUser('vendor', vendor))).toBe(vendor);
    });
  });
});

describe('isVendorScoped', () => {
  it('returns false for admin', () => {
    expect(isVendorScoped(makeUser('admin'))).toBe(false);
  });
  it('returns false for admin even with vendor assigned', () => {
    expect(isVendorScoped(makeUser('admin', 'Sai'))).toBe(false);
  });
  it('returns true for vendor with vendor assigned', () => {
    expect(isVendorScoped(makeUser('vendor', 'Sai'))).toBe(true);
  });
  it('returns false for vendor without vendor assigned', () => {
    expect(isVendorScoped(makeUser('vendor'))).toBe(false);
  });
  it('returns false for coordinator without vendor', () => {
    expect(isVendorScoped(makeUser('coordinator'))).toBe(false);
  });
  it('returns false for null user', () => {
    expect(isVendorScoped(null)).toBe(false);
  });
  it('returns false for undefined user', () => {
    expect(isVendorScoped(undefined)).toBe(false);
  });
});
