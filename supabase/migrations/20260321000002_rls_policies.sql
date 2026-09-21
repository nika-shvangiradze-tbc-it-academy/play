-- =============================================================================
-- Row Level Security policies
-- Documented in docs/database.md
-- =============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_players ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- Read: authenticated users can read profiles (usernames needed for lobby/history).
-- This is intentional public-read of non-sensitive profile fields among signed-in users.
CREATE POLICY profiles_select_authenticated
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (true);

-- Insert: only own profile (trigger also inserts via security definer)
CREATE POLICY profiles_insert_own
  ON public.profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid());

-- Update: only own profile; cannot forge games_played / games_won
CREATE POLICY profiles_update_own
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND games_played = (SELECT p.games_played FROM public.profiles p WHERE p.id = auth.uid())
    AND games_won = (SELECT p.games_won FROM public.profiles p WHERE p.id = auth.uid())
  );

-- No DELETE for authenticated clients
-- service_role bypasses RLS for trusted server mutations

-- ---------------------------------------------------------------------------
-- game_rooms
-- Private rooms: no public listing. Participants (or host) may read their rooms.
-- Invite-code join is performed by the game server (service role), not by
-- granting broad SELECT on invite_code to all users.
-- ---------------------------------------------------------------------------
CREATE POLICY game_rooms_select_participant
  ON public.game_rooms
  FOR SELECT
  TO authenticated
  USING (
    host_user_id = auth.uid()
    OR public.is_room_participant(id, auth.uid())
  );

-- Clients must NOT insert/update/delete rooms directly.
-- All room mutations go through the Colyseus server (service_role).

-- ---------------------------------------------------------------------------
-- room_players
-- ---------------------------------------------------------------------------
CREATE POLICY room_players_select_participant
  ON public.room_players
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_room_participant(room_id, auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.game_rooms gr
      WHERE gr.id = room_id AND gr.host_user_id = auth.uid()
    )
  );

-- No client INSERT/UPDATE/DELETE — server authoritative

-- ---------------------------------------------------------------------------
-- matches
-- Participants may read their own match records (history).
-- Clients must NOT insert/update match results.
-- ---------------------------------------------------------------------------
CREATE POLICY matches_select_participant
  ON public.matches
  FOR SELECT
  TO authenticated
  USING (public.is_match_participant(id, auth.uid()));

-- ---------------------------------------------------------------------------
-- match_players
-- ---------------------------------------------------------------------------
CREATE POLICY match_players_select_participant
  ON public.match_players
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_match_participant(match_id, auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Notes (also in docs/database.md):
-- * No USING (true) write policies on sensitive tables.
-- * profiles SELECT uses USING (true) for authenticated only — usernames are
--   intentionally visible to signed-in users; email/passwords stay in auth schema.
-- * Match completion via public.complete_match() (SECURITY DEFINER, service_role).
-- * Invite-code brute force prevented at game-server rate limiter, not by
--   exposing game_rooms SELECT on invite_code to clients.
-- ---------------------------------------------------------------------------
