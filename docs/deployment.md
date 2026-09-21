# Production deployment preparation

## Services

1. **Angular web** — static hosting (Vercel, Netlify, S3+CloudFront, Nginx)
2. **Colyseus game server** — Node host with sticky sessions / single node for MVP (Fly.io, Railway, Render, VM)
3. **Supabase** — managed Auth + Postgres

## Required secrets (server only)

| Variable | Where |
|----------|--------|
| `SUPABASE_SECRET_KEY` | Game server only (`sb_secret_...`) |
| `SUPABASE_URL` | Game server + web |
| `SUPABASE_PUBLISHABLE_KEY` | Web (public) + optional server (`sb_publishable_...`) |
| `CORS_ORIGINS` | Game server — comma-separated browser origins, e.g. `https://gartoba.netlify.app,http://localhost:4200` (legacy `CORS_ORIGIN` still accepted) |
| `NODE_ENV=production` | Game server |

User JWTs are verified via JWKS (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`, ES256).  
Do **not** configure `SUPABASE_JWT_SECRET` / the legacy JWT secret.

Never ship `SUPABASE_SECRET_KEY` in the Angular bundle.

## Checklist

- [ ] Apply all `supabase/migrations` to production (through `20260321000005_ensure_table_grants.sql` — required to avoid `permission denied for table profiles`)
- [ ] Confirm email auth templates / redirect URLs
- [ ] Confirm asymmetric JWT signing key (ES256) is active; JWKS returns public keys
- [ ] Set Angular `environment.ts` production URLs (`https` / `wss`) + publishable key
- [ ] On Render: `SUPABASE_SECRET_KEY=sb_secret_…` (never the publishable key); confirm logs show `Supabase server key configured: secret`
- [ ] Enable WSS termination (TLS) in front of Colyseus
- [ ] Configure CORS to the real web origin only
- [ ] Process manager / health check on `GET /api/health`
- [ ] Log aggregation; no stack traces to clients
- [ ] Rate limits tuned for expected traffic
- [ ] Backups for Postgres (Supabase defaults)
- [ ] Multi-node Colyseus only after adding shared presence (Redis) — MVP is single node

## Build

```bash
npm ci
npm run build
```

Artifacts:

- `apps/web/dist/web/browser` (Angular)
- `apps/game-server/dist` (Node)

Start server:

```bash
NODE_ENV=production node apps/game-server/dist/index.js
```
