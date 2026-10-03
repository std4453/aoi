import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type NativeProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;
const variants: Record<Variant, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-500',
  secondary: 'bg-gray-800 text-gray-300 hover:bg-gray-700',
  danger: 'bg-red-600 text-white hover:bg-red-500',
  ghost: 'text-gray-400 hover:bg-gray-800 hover:text-white',
};
const base = 'min-w-0 rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-50 disabled:cursor-not-allowed';

/** Prefer text-only actions; leading icons are reserved for documented exceptions. */
export function Button({ children, icon, variant = 'secondary', className = '', type = 'button', ...props }:
  NativeProps & { children: string; icon?: ReactElement; variant?: Variant }) {
  return <button {...props} type={type} className={`${base} min-h-9 px-3 py-2 text-center text-sm ${icon ? 'inline-flex items-center justify-center gap-2' : ''} ${variants[variant]} ${className}`}>{icon && <span aria-hidden="true" className="shrink-0">{icon}</span>}{children}</button>;
}

export function IconButton({ icon, label, variant = 'ghost', className = '', type = 'button', ...props }:
  NativeProps & { icon: ReactElement; label: string; variant?: Variant; children?: never }) {
  return <button {...props} type={type} aria-label={label} className={`${base} inline-flex h-8 w-8 shrink-0 items-center justify-center ${variants[variant]} ${className}`}>{icon}</button>;
}

/** Secondary on the left, primary on the right; equal columns when paired. */
export function ActionRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`grid auto-cols-fr grid-flow-col gap-2 ${className}`}>{children}</div>;
}
