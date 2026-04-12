import { useRef, useCallback } from 'react';

// Module-level state: single body, single lock counter
let lockCount = 0;
let savedScrollY = 0;

const expandedChromeHeight = window.outerHeight - window.innerHeight;

function isAtScrollBottom() {
  // Use documentElement.scrollHeight for accuracy — it accounts for
  // margins/padding that body.scrollHeight sometimes misses
  const scrollableHeight = document.documentElement.scrollHeight;
  return Math.ceil(window.scrollY + window.innerHeight) >= scrollableHeight - 2;
}

function applyLock() {
  savedScrollY = window.scrollY;

  const atBottom = isAtScrollBottom();
  const currentChromeHeight = window.outerHeight - window.innerHeight;
  const isCollapsed = currentChromeHeight < expandedChromeHeight - 10;

  if (isCollapsed) {
    // The bar is actually collapsed — scroll up by the difference
    // so Safari has room to re-expand the chrome
    const deficit = expandedChromeHeight - currentChromeHeight;
    window.scrollBy(0, -deficit);
  } else if (atBottom) {
    // Address bar looks expanded, but we're at the scroll bottom —
    // Safari's layout coordinates may be stale.
    // A 1px nudge forces a geometry flush without any visible jump.
    window.scrollBy(0, -1);
  }
  
  const s = document.body.style;
  s.position = 'fixed';
  s.top = `-${savedScrollY}px`;
  s.left = '0';
  s.right = '0';
  s.overflow = 'hidden';
}

function removeLock() {
  const s = document.body.style;
  s.position = '';
  s.top = '';
  s.left = '';
  s.right = '';
  s.overflow = '';
  window.scrollTo(0, savedScrollY);
}

/**
 * Imperative body scroll lock with reference counting.
 * Nested calls (e.g. Modal inside BottomPanel) are safe —
 * only the outermost unlock restores scroll.
 */
export function useBodyScrollLock() {
  const lockedRef = useRef(false);

  const lock = useCallback(() => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    if (lockCount === 0) applyLock();
    lockCount++;
  }, []);

  const unlock = useCallback(() => {
    if (!lockedRef.current) return;
    lockedRef.current = false;
    lockCount--;
    if (lockCount <= 0) {
      lockCount = 0;
      removeLock();
    }
  }, []);

  return { lock, unlock };
}
