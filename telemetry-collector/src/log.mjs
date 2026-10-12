/**
 * Structured JSON logs. Only ids, counts and reason codes belong here: never a report body,
 * a token, a header or an address. Callers pass plain scalar fields.
 */
export function createLogger(write = (line) => process.stdout.write(line)) {
  const emit = (level, msg, fields = {}) => {
    const safe = {};
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) safe[key] = value;
    }
    write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...safe })}\n`);
  };
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
