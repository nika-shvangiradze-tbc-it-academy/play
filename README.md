# Kartuli — Georgian Classics Online

Production-oriented multiplayer web platform for traditional Georgian table games.

**MVP vertical slice:** Register → Login → Create Nardi room → Invite code → Second player joins → Ready → Live match (server-authoritative dice & moves) → Finish → History.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Angular 19 (standalone, signals, SCSS) |
| Auth / DB | Supabase Auth + PostgreSQL + RLS |
| Game server | Node.js + TypeScript + Colyseus |
| Shared | `@georgian-games/shared` (contracts, Nardi engine) |

```
Angular  --HTTPS-->  Supabase Auth / PostgreSQL
   |                      ^
   | JWT                  | secret key (server only)
   v                      |
Colyseus  <--persist-----/   (JWT verified via JWKS / ES256)
   |
   WebSocket
   v
Players
```

## Monorepo

```
apps/web            Angular client
apps/game-server    Colyseus + HTTP API
packages/shared     Shared types + NardiEngine
supabase/migrations SQL schema + RLS
docs/               Architecture notes
```

## Quick start

### 1. Install

```bash
npm install
```

### 2. Supabase

1. Create a Supabase project.
2. Run SQL migrations in order from `supabase/migrations/`.
3. Copy **Project URL**, **publishable** key (`sb_publishable_...`), and **secret** key (`sb_secret_...`).
4. Ensure JWT Signing Keys use an asymmetric key (ECC P-256 / ES256).  
   The game server verifies user tokens via JWKS — not the legacy JWT secret.

### 3. Environment

```bash
cp .env.example .env
```

Fill server values in `.env` (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`).

Update Angular envs (publishable key only):

- `apps/web/src/environments/environment.development.ts`
- `apps/web/src/environments/environment.ts`

Use **only** `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` in the browser.  
Never put `SUPABASE_SECRET_KEY` in Angular.

### 4. Run

```bash
npm run build:shared
npm run dev
```

- Web: http://localhost:4200  
- Game server: http://localhost:2567  

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Angular + Colyseus |
| `npm run build` | Build shared, server, web |
| `npm test` | Shared + server unit tests |
| `npm run typecheck` | TypeScript checks |

### Netlify (Angular only)

Deploy from the **repository root** (do not set Base directory to `apps/web`). See `netlify.toml`:

| Setting | Value |
|---------|-------|
| Build command | `npm run build:shared && npm run build:web` |
| Publish directory | `apps/web/dist/web/browser` |

`@georgian-games/shared` is an npm workspace package under `packages/shared` — it is never published to npmjs.org.

Production Angular env (`apps/web/src/environments/environment.ts`) must use your deployed Colyseus `https://` / `wss://` URLs and only the Supabase **publishable** key. Never put `SUPABASE_SECRET_KEY` in the frontend.

## Games

| Game | Status |
|------|--------|
| Nardi (Backgammon) | Playable |
| Joker | Coming soon |
| Domino | Coming soon |
| Bura | Coming soon |

See [docs/adding-new-game.md](docs/adding-new-game.md).

## Security highlights

- Client sends **intents only** (`ROLL_DICE`, `MOVE_CHECKER`, …).
- Colyseus verifies Supabase JWT via JWKS (ES256); never trusts client `userId`.
- Dice / legality / winners are server-authoritative.
- RLS blocks clients from forging match results.
- Invite codes are rate-limited; rooms are not publicly listed.

## Documentation

- [Architecture](docs/architecture.md)
- [Database & RLS](docs/database.md)
- [Realtime protocol](docs/realtime-protocol.md)
- [Adding a new game](docs/adding-new-game.md)
