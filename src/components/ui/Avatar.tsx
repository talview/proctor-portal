import { getInitials } from '@/utils/formatters';

const SIZE_CLASSES = {
  sm: 'w-6 h-6 text-[10px]',
  md: 'w-8 h-8 text-[13px]',
  lg: 'w-10 h-10 text-base',
} as const;

/**
 * A colored circle showing a person's initials -- same gradient treatment the
 * sidebar's own profile corner already used, just generalized to two letters
 * (via getInitials) and reused everywhere else a name needs a face: the
 * Workspace greeting, the Proctors table, etc.
 */
export default function Avatar({
  name,
  size = 'md',
  className = '',
  title,
}: {
  name?: string | null;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
  title?: string;
}) {
  const initials = name?.trim() ? getInitials(name.trim()) : 'U';
  return (
    <div
      className={`rounded-full bg-gradient-to-br from-accent to-accent5 flex items-center justify-center font-bold text-white flex-shrink-0 ${SIZE_CLASSES[size]} ${className}`}
      title={title ?? (name || 'User')}
    >
      {initials}
    </div>
  );
}
