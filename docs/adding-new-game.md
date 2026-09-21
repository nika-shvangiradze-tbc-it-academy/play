# Adding a new game

The platform is built so **Joker / Domino / Bura** plug in without rewriting auth, lobby shell, invite codes, reconnection, or match history.

## Checklist

### 1. Shared catalog

In `packages/shared/src/models/index.ts` set `available: true` on the game entry (or add modes).

### 2. Shared contracts / engine

Create `packages/shared/src/game-types/<game>/`:

- pure state types
- pure rules functions
- `<Game>Engine` class (injectable RNG)
- unit tests (no Angular / Colyseus)

Export from `packages/shared/src/index.ts`.

### 3. Colyseus room

```ts
// apps/game-server/src/rooms/JokerRoom.ts
export class JokerRoom extends BaseGameRoom {
  getGameType() { return GameType.JOKER; }
  protected onMatchStart() { /* init engine */ }
  protected async onGameIntent(client, session, message) { /* validate */ }
}
```

Register in `apps/game-server/src/index.ts`:

```ts
gameServer.define('joker', JokerRoom);
```

Update HTTP create handler to `matchMaker.createRoom('joker', metadata)` based on `gameType`.

### 4. Schema fields

Extend `GameRoomState` **sparingly**, or add a nested schema for that game’s board. Keep lobby fields (`seats`, `phase`, `inviteCode`) shared.

### 5. Angular UI

- Enable the lobby card (`PLAY` instead of Coming soon).
- Add `apps/web/src/app/games/<game>/` board component.
- Route from `room.page` when `gameType` matches (same waiting room).

### 6. Persistence

Reuse `createMatchRecord` / `complete_match`. Add game-specific score fields only if needed (`match_players.score` already exists).

### 7. Do not reinvent

Leave untouched:

- Supabase Auth / profiles
- invite code generation
- `BaseGameRoom` ready/start/reconnect
- history & profile pages
- JWT verification

## Intent pattern

Always:

```ts
client → { type: 'PLAY_CARD', cardId }
server → validate turn/ownership/rules → mutate → sync state
```

Never:

```ts
client → { type: 'DEAL', deck: [...] }
```
