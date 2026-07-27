import path from 'node:path';

function replaceExtension(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '.jpg');
}

/**
 * Map source image paths to deterministic, collision-free JPEG paths.
 * Most files keep the familiar `name.jpg`; only same-stem collisions retain
 * their original extension (for example `name.png.jpg`).
 */
export function buildJpegOutputPaths(sourcePaths: string[]): Map<string, string> {
  const normalized = sourcePaths.map(value => value.split(path.sep).join('/'));
  const desiredCounts = new Map<string, number>();
  for (const source of normalized) {
    const desired = replaceExtension(source);
    desiredCounts.set(desired, (desiredCounts.get(desired) ?? 0) + 1);
  }

  const result = new Map<string, string>();
  const used = new Set<string>();

  // Reserve all non-colliding conventional names first.
  for (const source of [...normalized].sort()) {
    const desired = replaceExtension(source);
    if (desiredCounts.get(desired) === 1) {
      result.set(source, desired);
      used.add(desired);
    }
  }

  for (const source of [...normalized].sort()) {
    if (result.has(source)) continue;
    let candidate = `${source}.jpg`;
    let suffix = 1;
    while (used.has(candidate)) {
      candidate = `${source}.converted-${suffix}.jpg`;
      suffix++;
    }
    result.set(source, candidate);
    used.add(candidate);
  }

  return result;
}
