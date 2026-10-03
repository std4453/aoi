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
