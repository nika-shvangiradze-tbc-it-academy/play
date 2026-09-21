# Realtime protocol

## Transport

- Colyseus WebSocket to `GAME_SERVER_URL`
- Schema state sync for board / seats / dice
- Named messages for intents and lifecycle events

## Client → server intents

Envelope: `room.send('intent', payload)`

| type | payload | meaning |
|------|---------|---------|
| `READY` | — | Mark ready in lobby |
| `UNREADY` | — | Clear ready |
| `LEAVE_ROOM` | — | Voluntary leave |
| `ROLL_DICE` | — | Request server dice |
| `MOVE_CHECKER` | `{ from, to }` | Request move |
| `PASS` | — | Pass when no moves (rare; usually auto) |

**Never** send dice values, shuffled decks, scores, or winners from the client.

Point conventions (Nardi):

- Points `1–24`
- `from: 0` = bar
- `to: 25` = bear off

## Server → client events

| event | meaning |
|-------|---------|
| schema `onStateChange` | Authoritative state |
| `MATCH_STARTED` | `{ matchId }` |
| `MATCH_FINISHED` | `{ matchId, winnerUserId, reason }` |
| `PLAYER_DISCONNECTED` | grace period info |
| `PLAYER_RECONNECTED` | seat restored |
| `ACTION_REJECTED` / `ERROR` | `{ code, message }` |

## Error codes

See `ErrorCode` in `@georgian-games/shared` (`UNAUTHENTICATED`, `INVALID_MOVE`, `NOT_YOUR_TURN`, `ROOM_FULL`, …).

## HTTP helpers

| method | path | purpose |
|--------|------|---------|
| POST | `/api/rooms` | Create private room + Colyseus instance |
| GET | `/api/rooms/by-code/:code` | Minimal validity lookup |
| POST | `/api/rooms/join` | Reserve seat + return Colyseus id |
| GET | `/api/health` | Liveness |
