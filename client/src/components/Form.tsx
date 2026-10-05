import { cloneElement, useId, useState, type InputHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { IconButton } from './Button';

export const inputClass = 'w-full min-w-0 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500 placeholder:text-gray-500 disabled:opacity-50';

export function FormField({ label, children, hint, error }: { label: string; children: ReactElement<InputHTMLAttributes<HTMLInputElement>>; hint?: ReactNode; error?: string | null }) {
  const generatedId = useId();
  const id = children.props.id ?? generatedId;
  const describedBy = [children.props['aria-describedby'], error ? `${id}-error` : undefined].filter(Boolean).join(' ') || undefined;
  return <div className="flex min-w-0 flex-col gap-1.5 text-sm text-gray-400">
    <div className="flex items-center justify-between gap-2"><label htmlFor={id}>{label}</label>{hint}</div>
    {cloneElement(children, { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : children.props['aria-invalid'] })}
    {error && <span id={`${id}-error`} role="alert" className="text-xs text-red-400">{error}</span>}
  </div>;
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${className}`} />;
}

export function PasswordInput({ value, onChange, placeholder = '密码', disabled = false, id: inputId, autoComplete = 'off', ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: string; onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const generatedId = useId();
  const id = inputId ?? generatedId;
  return <div className={`flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 focus-within:border-blue-500 ${disabled ? 'opacity-50' : ''}`}>
    <Lock size={16} className="shrink-0 text-gray-500" />
    <input {...props} id={id} type={visible ? 'text' : 'password'} autoComplete={autoComplete} value={value} disabled={disabled}
      onChange={event => onChange(event.target.value)} aria-label={placeholder} placeholder={placeholder}
      className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-gray-500" />
    <IconButton disabled={disabled} onClick={() => setVisible(!visible)} label={`${visible ? '隐藏' : '显示'}${placeholder}`}
      aria-controls={id} aria-pressed={visible} className="-my-2 -mr-2 text-gray-500" icon={visible ? <EyeOff size={16} /> : <Eye size={16} />} />
  </div>;
}
