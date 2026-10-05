/** Keep fatal errors useful without logging messages, request data or user paths. */
export function errorDiagnostics(value: unknown): object {
  const types = [TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError, Error];
  const type = types.find(constructor => value instanceof constructor)?.name ?? 'NonError';
  if (!(value instanceof Error)) return { type };
  const code = (value as Error & { code?: unknown }).code;
  const locations = (value.stack ?? '').split('\n').filter(line => /^\s+at /.test(line))
    .flatMap(line => {
      // Strip absolute prefixes and function names. Only code locations survive;
      // data directories, URLs, error messages and arbitrary properties do not.
      const location = /(?:\/|\\)((?:server\/src|shared|node_modules)\/[\w@./+-]+:\d+:\d+)\)?$/.exec(line)?.[1]
        ?? /\b(node:[\w/.-]+:\d+:\d+)\)?$/.exec(line)?.[1];
      return location ? [location] : [];
    }).slice(0, 12);
  return { type, ...(typeof code === 'string' && /^(?:E[A-Z]{2,30}|(?:ERR_|UND_ERR_)[A-Z_]{1,60})$/.test(code) ? { code } : {}), locations };
}
