/// <reference types="node" />
export function renderWindowsSupervisorSource(source: Buffer): string;
export function decodeWindowsSupervisorSource(
  block: string,
  identity: { size: number; sha256: string },
): Buffer;
