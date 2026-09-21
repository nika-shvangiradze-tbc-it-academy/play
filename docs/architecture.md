# Architecture

## Overview

Kartuli separates **identity/persistence** (Supabase) from **authoritative realtime play** (Colyseus).

```
┌─────────────┐     HTTPS/JWT      ┌──────────────────┐
│ Angular Web │ ─────────────────► │ Supabase Auth +  │
│             │ ◄───────────────── │ PostgreSQL / RLS │
└──────┬──────┘                    └─────────▲────────┘
       │ WebSocket + JWT                      │
       ▼                                      │ secret key (server only)
┌──────────────────┐                          │
│ Colyseus Server  │ ─────────────────────────┘
│ BaseGameRoom     │   room metadata, match
│ NardiRoom        │   start/end, stats
│ NardiEngine      │
└──────────────────┘
```

## Authentication flow

1. User signs up / logs in via Supabase Auth (email + password).
2. A `profiles` row is created by trigger `handle_new_user`.
3. Angular stores the session (persisted) and attaches `access_token` when calling the game server.
4. HTTP `/api/*` and Colyseus `onAuth` verify the JWT against the project JWKS
   (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`) using ES256 (ECC P-256).
   Signature, expiry, issuer, audience, and `sub` are validated. No legacy JWT secret.
5. Server loads the profile for the verified `sub` — never a client-supplied user id.

## Room lifecycle

1. Authenticated user `POST /api/rooms` `{ gameType: "nardi" }`.
2. Server generates invite code, inserts `game_rooms` + host `room_players`, creates Colyseus room.
3. Host joins Colyseus by room id with JWT.
4. Guest `POST /api/rooms/join` with invite code → seat reserved → joins same Colyseus room.
5. Both send `READY` → server starts match idempotently → `matches` + `match_players` rows.
6. Play continues in memory on Colyseus.
7. On finish / abandonment, `complete_match` RPC persists results and updates profile stats.

## Database vs live state

| In PostgreSQL | In Colyseus memory |
|---------------|--------------------|
| profiles | seats, ready flags |
| room metadata / invite codes | board, dice, legal moves |
| match start/end, winner, scores | turn phase, reconnect timers |
| history queries | high-frequency move stream |

Do **not** write every checker animation or die face flip to SQL.

## Game lifecycle (Nardi)

Phases (`RoomPhase`): `WAITING` → `STARTING` → `PLAYING` → `FINISHED`

Nardi sub-phases (`NardiPhase`): `WAITING_FOR_ROLL` → `WAITING_FOR_MOVE` → (`TURN_COMPLETE` implicit) → `GAME_OVER`

`NardiEngine` is pure TypeScript in `@georgian-games/shared` so rules are unit-tested without Angular or Colyseus.

## WebSocket authentication

```
client.joinById(roomId, { accessToken })
  → room.onAuth verifies JWT via JWKS (ES256)
     issuer = {SUPABASE_URL}/auth/v1
     userId = verified payload.sub only
  → returns AuthProfile
  → onJoin assigns / restores seat
```

Rejects: missing/invalid/expired token, wrong issuer, duplicate live connection, full room, already-started join (except reconnect).

## Reconnection

On unexpected disconnect during a match:

- Seat reserved for `RECONNECT_GRACE_MS` (default 60s)
- Opponent sees reconnecting status
- Same authenticated user rejoins and receives current authoritative state
- Timeout → abandonment policy → opponent wins

## Future games

`BaseGameRoom` owns auth, seats, ready, match persistence, reconnect.  
`NardiRoom` (and future `JokerRoom`, …) only implement game intents + engine sync.
