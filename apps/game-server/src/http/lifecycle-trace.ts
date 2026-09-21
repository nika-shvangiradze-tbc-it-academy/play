import { randomBytes } from 'node:crypto';
import { matchMaker } from '@colyseus/core';

/** Short non-sensitive correlation id for one application-room lifecycle. */
export function newLifecycleTraceId(): string {
  return randomBytes(4).toString('hex');
}

export function shortId(value: string | undefined | null, n = 8): string {
  if (!value) return '?';
  return value.length <= n ? value : value.slice(0, n);
}

export function processIdentity(): { pid: number; processId: string } {
  return {
    pid: process.pid,
    processId: String(matchMaker.processId ?? 'none'),
  };
}

export function traceLog(traceId: string, message: string): void {
  const { pid, processId } = processIdentity();
  console.log(`[trace:${traceId}] ${message} | processId=${processId} pid=${pid}`);
}
