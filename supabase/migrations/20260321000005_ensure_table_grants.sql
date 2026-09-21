-- =============================================================================
-- Ensure Data API roles can access game tables (production fix)
-- =============================================================================
-- Symptom: PostgREST / supabase-js returns:
--   "permission denied for table profiles" (SQLSTATE 42501)
--
-- That is a GRANT failure, not an RLS policy miss. service_role / secret keys
-- still need table privileges; BYPASSRLS only skips policies after GRANT.
--
-- Safe to re-run (GRANT is idempotent). Does not weaken RLS.
-- =============================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT ALL ON TABLE public.profiles TO service_role;
GRANT ALL ON TABLE public.game_rooms TO service_role;
GRANT ALL ON TABLE public.room_players TO service_role;
GRANT ALL ON TABLE public.matches TO service_role;
GRANT ALL ON TABLE public.match_players TO service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;
GRANT SELECT ON TABLE public.game_rooms TO authenticated;
GRANT SELECT ON TABLE public.room_players TO authenticated;
GRANT SELECT ON TABLE public.matches TO authenticated;
GRANT SELECT ON TABLE public.match_players TO authenticated;

-- anon: no table access (browser must authenticate). Keep schema USAGE only.

GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Future tables created by this role owner get the same defaults for API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO authenticated;
