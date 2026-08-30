export function parseSupervisorStatusFrame(bytes: Buffer | string): {
  code: number | null;
  signal: string | null;
  reason: string;
};
