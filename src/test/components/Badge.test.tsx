import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Badge from '@/components/ui/Badge';
import type { ProctorStatus } from '@/types';

const ALL_STATUSES: ProctorStatus[] = [
  'In Progress',
  'Verified',
  'Active',
  'Offboarded',
  'Archived',
];

describe('Badge', () => {
  it.each(ALL_STATUSES)('renders "%s" without crashing', (status) => {
    expect(() => render(<Badge status={status} />)).not.toThrow();
  });

  it.each(ALL_STATUSES)('renders the text content for "%s"', (status) => {
    render(<Badge status={status} />);
    expect(screen.getByText(status)).toBeInTheDocument();
  });

  it('Archived status renders with visible styling (not empty class)', () => {
    const { container } = render(<Badge status="Archived" />);
    const span = container.querySelector('span');
    expect(span).not.toBeNull();
    // The outer span should have non-empty class containing the Archived styles
    expect(span!.className).toContain('text-text3');
  });

  it('Active status renders with success color class', () => {
    const { container } = render(<Badge status="Active" />);
    const span = container.querySelector('span');
    expect(span!.className).toContain('text-success');
  });

  it('In Progress status renders with info color class', () => {
    const { container } = render(<Badge status="In Progress" />);
    const span = container.querySelector('span');
    expect(span!.className).toContain('text-info');
  });

  it('Offboarded status renders with a neutral (text3) color class', () => {
    const { container } = render(<Badge status="Offboarded" />);
    const span = container.querySelector('span');
    expect(span!.className).toContain('text-text3');
  });

  it('Verified status renders with warning color class', () => {
    const { container } = render(<Badge status="Verified" />);
    const span = container.querySelector('span');
    expect(span!.className).toContain('text-warning');
  });

  it('renders a dot indicator element inside the badge', () => {
    const { container } = render(<Badge status="Active" />);
    // Badge renders a nested span for the dot indicator
    const innerSpan = container.querySelector('span > span');
    expect(innerSpan).toBeInTheDocument();
    expect(innerSpan!.className).toContain('rounded-full');
  });

  it('renders as an inline-flex element', () => {
    const { container } = render(<Badge status="Verified" />);
    const span = container.querySelector('span');
    expect(span!.className).toContain('inline-flex');
  });
});
