import path from 'node:path';

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\//;

export function validateIdentifier(value: string, label = 'identifier'): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function normalizeRelativePath(value: string, label = 'relative path'): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    /[\0-\x1F\x7F]/.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }

  const portable = value.replace(/\\/g, '/');
  if (portable.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(portable)) {
    throw new Error(`${label} must not be absolute`);
  }

  const segments = portable.split('/');
  if (
    segments.length > 256 ||
    segments.some(segment =>
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      Buffer.byteLength(segment, 'utf8') > 255
    )
  ) {
    throw new Error(`${label} contains an unsafe path segment`);
  }

  return segments.join('/');
}

export function resolveWithin(baseDir: string, relativePath: string, label = 'relative path'): string {
  const normalized = normalizeRelativePath(relativePath, label);
  const root = path.resolve(baseDir);
  const candidate = path.resolve(root, ...normalized.split('/'));
  if (!candidate.startsWith(root + path.sep)) {
    throw new Error(`${label} escapes its allowed directory`);
  }
  return candidate;
}
