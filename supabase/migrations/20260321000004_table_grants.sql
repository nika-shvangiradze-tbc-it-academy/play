-- =============================================================================
-- Table / sequence privileges for PostgREST roles
-- Without these GRANTs, queries fail with "permission denied for table …"
-- even when RLS policies exist. service_role still bypasses RLS after GRANT.
-- =============================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT ALL ON TABLE public.profiles TO service_role;
GRANT ALL ON TABLE public.game_rooms TO service_role;
GRANT ALL ON TABLE public.room_players TO service_role;
GRANT ALL ON TABLE public.matches TO service_role;
GRANT ALL ON TABLE public.match_players TO service_role;

-- Authenticated clients: privileges required for RLS policies to take effect.
GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;
GRANT SELECT ON TABLE public.game_rooms TO authenticated;
GRANT SELECT ON TABLE public.room_players TO authenticated;
GRANT SELECT ON TABLE public.matches TO authenticated;
GRANT SELECT ON TABLE public.match_players TO authenticated;

GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
