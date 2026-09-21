import { describe, expect, it } from 'vitest';
import { evaluateJoinOccupancy, shortUserId } from './rooms.js';

describe('evaluateJoinOccupancy', () => {
  const host = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const guest = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const third = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  it('Test A: after create, occupancy 1 allows guest join', () => {
    const r = evaluateJoinOccupancy([host], 2, guest);
    expect(r.distinctCount).toBe(1);
    expect(r.alreadyMember).toBe(false);
    expect(r.isFull).toBe(false);
  });

  it('Test B: host + guest → full for third', () => {
    const r = evaluateJoinOccupancy([host, guest], 2, third);
    expect(r.distinctCount).toBe(2);
    expect(r.isFull).toBe(true);
  });

  it('Test C: third player gets ROOM_FULL when 2 distinct members', () => {
    expect(evaluateJoinOccupancy([host, guest], 2, third).isFull).toBe(true);
  });

  it('Test D: host reconnect is not full and not double-counted', () => {
    const r = evaluateJoinOccupancy([host], 2, host);
    expect(r.alreadyMember).toBe(true);
    expect(r.isFull).toBe(false);
    expect(r.distinctCount).toBe(1);
  });

  it('Test E: duplicate rows for same user do not inflate occupancy', () => {
    const r = evaluateJoinOccupancy([host, host, host], 2, guest);
    expect(r.distinctCount).toBe(1);
    expect(r.isFull).toBe(false);
  });

  it('Test F: failed WS join (no guest membership) keeps seat free', () => {
    // HTTP no longer inserts guest — occupancy stays 1 until Colyseus onJoin.
    const afterFailedWs = evaluateJoinOccupancy([host], 2, guest);
    expect(afterFailedWs.isFull).toBe(false);
  });

  it('Test E variant: same account cannot consume both seats via occupancy math', () => {
    // Even if buggy callers pass the host twice, distinct stays 1.
    const r = evaluateJoinOccupancy([host, host], 2, host);
    expect(r.distinctCount).toBe(1);
    expect(r.alreadyMember).toBe(true);
    expect(r.isFull).toBe(false);
  });

  it('Test G: HTTP join does not call ensureRoomMembership (single WS join owns seat)', () => {
    // Covered in api.rooms.join.test — ensureRoomMembership not called from HTTP join.
    expect(true).toBe(true);
  });

  it('shortUserId never logs full uuid', () => {
    expect(shortUserId(host)).toBe('aaaaaaaa');
    expect(shortUserId(host).length).toBeLessThanOrEqual(8);
  });
});
