import type { ColyseusSeatReservation } from '@georgian-games/shared';

/** Minimal shape returned by Colyseus 0.15 matchMaker.reserveSeatFor / joinById / create. */
export interface ServerSeatReservation {
  sessionId: string;
  room: {
    roomId: string;
    name: string;
    processId: string;
    publicAddress?: string;
  };
}

/**
 * Serialize a Colyseus 0.15 SeatReservation for JSON over our Express API.
 * The Angular client passes this object to `client.consumeSeatReservation(...)`.
 */
export function toClientReservation(reservation: ServerSeatReservation): ColyseusSeatReservation {
  const room = reservation.room;
  return {
    sessionId: reservation.sessionId,
    room: {
      roomId: room.roomId,
      name: room.name,
      processId: room.processId,
      ...(room.publicAddress ? { publicAddress: room.publicAddress } : {}),
    },
  };
}

export function isRoomNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /room ".*?" not found/i.test(message);
}
