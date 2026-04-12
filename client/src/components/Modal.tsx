import { useState, useEffect, useRef } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

interface ModalProps {
  visible: boolean;
  onClose: () => void;
  onClosed?: () => void;
  className?: string;
  children: React.ReactNode;
}

export default function Modal({ visible, onClose, onClosed, className, children }: ModalProps) {
  const [phase, setPhase] = useState<'closed' | 'entering' | 'open' | 'exiting'>('closed');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { lock, unlock } = useBodyScrollLock();

  useEffect(() => {
    if (visible) {
      lock();
    } else {
      unlock();
    }
    return () => unlock();
  }, [visible, lock, unlock]);

  useEffect(() => {
    if (visible && phase === 'closed') {
      setPhase('entering');
    } else if (!visible && (phase === 'open' || phase === 'entering')) {
      setPhase('exiting');
    }
  }, [visible, phase]);

  useEffect(() => {
    if (phase === 'entering') {
      timerRef.current = setTimeout(() => setPhase('open'), 200);
    } else if (phase === 'exiting') {
      timerRef.current = setTimeout(() => {
        setPhase('closed');
        onClosed?.();
      }, 150);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase, onClosed]);

  if (phase === 'closed') return null;

  const animClass = phase === 'exiting' ? 'modal-exit' : 'modal-enter';

  return (
    <div className={`fixed inset-0 h-dvh z-50 flex items-center justify-center px-4 ${animClass}`}>
      <div
        className="modal-backdrop absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        className={`modal-body relative bg-gray-900 rounded-2xl border border-gray-800 w-full max-w-sm ${className ?? ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
