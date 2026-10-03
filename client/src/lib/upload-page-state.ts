let scrollY = 0;
let handledRevealRevision = 0;

export const getUploadScrollY = () => scrollY;
export const saveUploadScrollY = (value: number) => { scrollY = value; };
export const getHandledRevealRevision = () => handledRevealRevision;
export const setHandledRevealRevision = (value: number) => { handledRevealRevision = value; };

/** Reveal only the clipped part; cards taller than the viewport keep their heading visible. */
export function taskRevealDelta(top: number, bottom: number, visibleTop: number, visibleBottom: number): number {
  if (top >= visibleTop && bottom <= visibleBottom) return 0;
  if (top < visibleTop || bottom - top > visibleBottom - visibleTop) return top - visibleTop;
  return bottom - visibleBottom;
}

/** Start with the accordion and follow its growing scroll range instead of waiting for it. */
export function scrollWithTaskExpansion(top: number): () => void {
  const from = window.scrollY;
  if (Math.abs(top - from) <= 1) return () => {};
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.scrollTo({ top, behavior: 'instant' });
    return () => {};
  }
  const started = performance.now();
  let frame = 0;
  const cancel = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('wheel', cancel);
    window.removeEventListener('touchstart', cancel);
    window.removeEventListener('pointerdown', cancel);
    window.removeEventListener('keydown', onKeyDown);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancel();
  };
  const step = (now: number) => {
    const progress = Math.min(1, (now - started) / 240);
    window.scrollTo({ top: from + (top - from) * (1 - (1 - progress) ** 3), behavior: 'instant' });
    if (progress < 1) frame = requestAnimationFrame(step);
    else cancel();
  };
  window.addEventListener('wheel', cancel, { passive: true });
  window.addEventListener('touchstart', cancel, { passive: true });
  window.addEventListener('pointerdown', cancel, { passive: true });
  window.addEventListener('keydown', onKeyDown);
  frame = requestAnimationFrame(step);
  return cancel;
}
