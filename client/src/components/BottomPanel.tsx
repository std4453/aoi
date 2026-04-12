import { useState, useEffect, useRef, CSSProperties } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

interface BottomPanelProps {
  visible: boolean;
  keepMounted?: boolean;
  onClose: () => void;
  onEntered?: () => void;
  onClosed?: () => void;
  children: React.ReactNode;
}

/**
 * Bottom sheet with enter/exit animations.
 * - visible=true: plays slide-up enter animation
 * - visible=false: plays slide-down exit animation
 * - keepMounted=true: uses visibility:hidden instead of unmounting, preserving DOM state
 * - keepMounted=false (default): unmounts after exit animation
 * - onClose: triggers exit by notifying parent (parent should set visible=false)
 * - onEntered: called after enter animation completes
 * - onClosed: called after exit animation completes
 *
 * iOS Safari keyboard handling: uses the Visual Viewport API to detect
 * the virtual keyboard and shift the panel up via translateY, compensating
 * for Safari's behavior of pushing content up when the keyboard opens.
 */
export default function BottomPanel({ visible, keepMounted, onClose, onEntered, onClosed, children }: BottomPanelProps) {
  const [phase, setPhase] = useState<'hidden' | 'entering' | 'open' | 'exiting'>('hidden');
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardOffsetRef = useRef(0);

  const { lock, unlock } = useBodyScrollLock();

  useEffect(() => {
    if (visible) {
      lock();
    } else {
      unlock();
    }
    return () => unlock();
  }, [visible, lock, unlock]);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const elStyleRef = useRef<CSSProperties>({});
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const keyboardOpenRef = useRef(keyboardOpen);

  // iOS Safari keyboard detection via Visual Viewport API
  // Writes directly to the DOM — no React render cycle involved
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      if (!visibleRef.current) {
        return;
      }

      // since window scroll is disabled, need to compensate forced
      // scroll scrollY
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + window.scrollY;
      keyboardOffsetRef.current = offset;

      const el = containerRef.current;
      if (!el) return;

      if (offset > 0) {
        if (!keyboardOpenRef.current) {
          el.style.setProperty('--keyboard-offset', `${offset}px`);
          elStyleRef.current = {
            ['--keyboard-offset' as any]: `${offset}px`,
          }

          keyboardOpenRef.current = true;
          setKeyboardOpen(true);
        }
      } else {
        if (keyboardOpenRef.current) {
          el.style.removeProperty('--keyboard-offset');
          elStyleRef.current = {};

          keyboardOpenRef.current = false;
          setKeyboardOpen(false);
        }
      }

      // lock scroll since safari mysteriously scrolls an unscrollable
      // window
      window.scrollTo(0, 0);
    };

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  useEffect(() => {
    if (visible && phase === 'hidden') {
      setPhase('entering');
    } else if (!visible && (phase === 'open' || phase === 'entering')) {
      setPhase('exiting');
    }
  }, [visible, phase]);

  useEffect(() => {
    if (phase === 'entering') {
      timerRef.current = setTimeout(() => {
        setPhase('open');
        onEntered?.();
      }, 300);
    } else if (phase === 'exiting') {
      timerRef.current = setTimeout(() => {
        setPhase('hidden');
        onClosed?.();
      }, 200);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase, onEntered, onClosed]);

  const isHidden = phase === 'hidden';

  if (isHidden && !keepMounted) return null;

  const animClass = phase === 'exiting' ? 'bottom-panel-exit' : phase === 'entering' ? 'bottom-panel-enter' : '';

  return (
    <div
      ref={containerRef}
      className={`fixed left-0 top-0 right-0 h-dvh z-50 flex flex-col ${animClass} ${isHidden ? 'invisible pointer-events-none' : ''}`}
      style={elStyleRef.current}
    >
      <div
        className="panel-backdrop absolute inset-0 bg-black/70"
        onClick={onClose}
      />
      <div
        className={`panel-body relative flex flex-col bg-gray-900 w-full max-w-lg mx-auto ${keyboardOpen ? 'h-[90vh]' : 'h-[80vh]'} mt-auto mb-0 rounded-t-2xl border-t border-gray-700 transition-[height] duration-200 ease-out`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}