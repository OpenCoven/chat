// Registered as the system's web browser for the packaged suite. The operating
// system's opener starts it with the address it was handed; it appends exactly
// that argument to the log named first, and exits successfully.
// Usage: node record-url.mjs <log> <address>

import { appendFileSync } from 'node:fs';

const [log, address, ...rest] = process.argv.slice(2);
if (!log) process.exit(2);
appendFileSync(log, `${JSON.stringify({ at: Date.now(), address, extra: rest })}\n`);
