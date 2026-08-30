export function parseSupervisorStatusFrame(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  if (Buffer.byteLength(text) > 256 || !text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
    throw new Error('supervisor status frame was not canonical');
  }
  const status = JSON.parse(text);
  if (
    status === null ||
    typeof status !== 'object' ||
    Array.isArray(status) ||
    Object.keys(status).sort().join(',') !== 'code,reason,signal' ||
    !['exit', 'spawn', 'terminated', 'timeout'].includes(status.reason) ||
    (status.code !== null && !Number.isInteger(status.code)) ||
    (status.signal !== null && typeof status.signal !== 'string') ||
    (status.code !== null && status.signal !== null)
  ) {
    throw new Error('supervisor status frame was not canonical');
  }
  return status;
}
