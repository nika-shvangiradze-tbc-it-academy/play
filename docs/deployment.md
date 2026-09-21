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
| `CORS_ORIGIN` | Game server (exact web origin) |
| `NODE_ENV=production` | Game server |

User JWTs are verified via JWKS (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`, ES256).  
Do **not** configure `SUPABASE_JWT_SECRET` / the legacy JWT secret.

Never ship `SUPABASE_SECRET_KEY` in the Angular bundle.

## Checklist

- [ ] Apply all `supabase/migrations` to production
- [ ] Confirm email auth templates / redirect URLs
- [ ] Confirm asymmetric JWT signing key (ES256) is active; JWKS returns public keys
- [ ] Set Angular `environment.ts` production URLs (`https` / `wss`) + publishable key
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
