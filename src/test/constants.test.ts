import { describe, it, expect } from 'vitest';
import { VENDORS, PROCTOR_TYPES, STATUS_COLORS, STATUS_BADGES, INDIAN_STATES } from '@/utils/constants';

describe('VENDORS', () => {
  it('includes expected vendors', () => {
    expect(VENDORS).toContain('Sai');
    expect(VENDORS).toContain('TSN');
    expect(VENDORS).toContain('A&M');
  });
  it('includes all 6 vendors', () => {
    expect(VENDORS).toHaveLength(6);
  });
  it('includes Awign', () => {
    expect(VENDORS).toContain('Awign');
  });
  it('includes Avner', () => {
    expect(VENDORS).toContain('Avner');
  });
  it('includes ATS', () => {
    expect(VENDORS).toContain('ATS');
  });
});

describe('PROCTOR_TYPES', () => {
  it('includes WFO, ODP, Hybrid', () => {
    expect(PROCTOR_TYPES).toEqual(['WFO', 'ODP', 'Hybrid']);
  });
  it('has exactly 3 types', () => {
    expect(PROCTOR_TYPES).toHaveLength(3);
  });
});

describe('STATUS_COLORS', () => {
  it('has color for all ProctorStatus values', () => {
    const statuses = ['In Progress', 'Verified', 'Active', 'Offboarded', 'Archived'];
    statuses.forEach(status => {
      expect(STATUS_COLORS).toHaveProperty(status);
    });
  });
  it('Active maps to success', () => {
    expect(STATUS_COLORS['Active']).toBe('success');
  });
  it('Offboarded maps to neutral', () => {
    expect(STATUS_COLORS['Offboarded']).toBe('neutral');
  });
  it('In Progress maps to info', () => {
    expect(STATUS_COLORS['In Progress']).toBe('info');
  });
  it('Verified maps to warning', () => {
    expect(STATUS_COLORS['Verified']).toBe('warning');
  });
  it('Archived maps to secondary', () => {
    expect(STATUS_COLORS['Archived']).toBe('secondary');
  });
});

describe('STATUS_BADGES', () => {
  it('has badge class for Archived status', () => {
    expect(STATUS_BADGES).toHaveProperty('Archived');
    expect((STATUS_BADGES as Record<string, string>)['Archived']).toBeTruthy();
  });
  it('has badge class for all statuses', () => {
    const statuses = ['In Progress', 'Verified', 'Active', 'Offboarded', 'Archived'];
    statuses.forEach(status => {
      expect(STATUS_BADGES).toHaveProperty(status);
    });
  });
  it('Active badge contains success class', () => {
    expect(STATUS_BADGES['Active']).toContain('success');
  });
  it('Offboarded badge contains a neutral (text3) class', () => {
    expect(STATUS_BADGES['Offboarded']).toContain('text3');
  });
});

describe('INDIAN_STATES', () => {
  it('includes major states', () => {
    expect(INDIAN_STATES).toContain('Karnataka');
    expect(INDIAN_STATES).toContain('Maharashtra');
    expect(INDIAN_STATES).toContain('Tamil Nadu');
  });
  it('has at least 28 entries', () => {
    expect(INDIAN_STATES.length).toBeGreaterThanOrEqual(28);
  });
  it('includes North-Eastern states', () => {
    expect(INDIAN_STATES).toContain('Assam');
    expect(INDIAN_STATES).toContain('Manipur');
  });
  it('includes Goa', () => {
    expect(INDIAN_STATES).toContain('Goa');
  });
});
