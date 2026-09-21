-- =============================================================================
-- Georgian Games — initial schema
-- profiles, game_rooms, room_players, matches, match_players
-- =============================================================================

-- Enums
CREATE TYPE public.game_type AS ENUM ('nardi', 'joker', 'domino', 'bura');
CREATE TYPE public.room_status AS ENUM (
  'waiting',
  'starting',
  'playing',
  'finished',
  'abandoned',
  'cancelled'
);
CREATE TYPE public.match_status AS ENUM ('in_progress', 'completed', 'abandoned');
CREATE TYPE public.match_result AS ENUM ('win', 'loss', 'draw', 'abandoned');

-- ---------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  username text NOT NULL,
  username_normalized text NOT NULL,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  games_played integer NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  games_won integer NOT NULL DEFAULT 0 CHECK (games_won >= 0),
  CONSTRAINT profiles_username_length CHECK (
    char_length(username) >= 3 AND char_length(username) <= 20
  ),
  CONSTRAINT profiles_username_format CHECK (username ~ '^[A-Za-z0-9_]{3,20}$'),
  CONSTRAINT profiles_wins_not_exceed_played CHECK (games_won <= games_played)
);

CREATE UNIQUE INDEX profiles_username_normalized_uidx
  ON public.profiles (username_normalized);

CREATE INDEX profiles_created_at_idx ON public.profiles (created_at DESC);

-- Keep updated_at fresh
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Auto-create profile from auth metadata on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  raw_username text;
  normalized text;
BEGIN
  raw_username := coalesce(
    NEW.raw_user_meta_data ->> 'username',
    split_part(NEW.email, '@', 1)
  );
  raw_username := trim(raw_username);
  IF raw_username IS NULL OR char_length(raw_username) < 3 THEN
    raw_username := 'player_' || substr(replace(NEW.id::text, '-', ''), 1, 8);
  END IF;
  IF char_length(raw_username) > 20 THEN
    raw_username := left(raw_username, 20);
  END IF;
  -- Sanitize to allowed charset
  raw_username := regexp_replace(raw_username, '[^A-Za-z0-9_]', '_', 'g');
  normalized := lower(raw_username);

  INSERT INTO public.profiles (id, username, username_normalized)
  VALUES (NEW.id, raw_username, normalized)
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ---------------------------------------------------------------------------
-- game_rooms
-- ---------------------------------------------------------------------------
CREATE TABLE public.game_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code text NOT NULL,
  game_type public.game_type NOT NULL,
  status public.room_status NOT NULL DEFAULT 'waiting',
  host_user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE RESTRICT,
  max_players integer NOT NULL CHECK (max_players >= 2 AND max_players <= 4),
  colyseus_room_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT game_rooms_invite_code_format CHECK (
    invite_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'
  ),
  CONSTRAINT game_rooms_time_order CHECK (
    started_at IS NULL OR started_at >= created_at
  ),
  CONSTRAINT game_rooms_finish_order CHECK (
    finished_at IS NULL OR (started_at IS NOT NULL AND finished_at >= started_at)
  )
);

CREATE UNIQUE INDEX game_rooms_invite_code_uidx ON public.game_rooms (invite_code);
CREATE INDEX game_rooms_host_idx ON public.game_rooms (host_user_id);
CREATE INDEX game_rooms_status_idx ON public.game_rooms (status);
CREATE INDEX game_rooms_colyseus_idx ON public.game_rooms (colyseus_room_id);

-- ---------------------------------------------------------------------------
-- room_players
-- ---------------------------------------------------------------------------
CREATE TABLE public.room_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.game_rooms (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  seat_number integer NOT NULL CHECK (seat_number >= 0 AND seat_number <= 3),
  is_ready boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  CONSTRAINT room_players_left_after_join CHECK (
    left_at IS NULL OR left_at >= joined_at
  )
);

-- One active seat per user per room
CREATE UNIQUE INDEX room_players_room_user_active_uidx
  ON public.room_players (room_id, user_id)
  WHERE left_at IS NULL;

-- One user per seat while active
CREATE UNIQUE INDEX room_players_room_seat_active_uidx
  ON public.room_players (room_id, seat_number)
  WHERE left_at IS NULL;

CREATE INDEX room_players_user_idx ON public.room_players (user_id);

-- ---------------------------------------------------------------------------
-- matches
-- ---------------------------------------------------------------------------
CREATE TABLE public.matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.game_rooms (id) ON DELETE RESTRICT,
  game_type public.game_type NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  winner_user_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  status public.match_status NOT NULL DEFAULT 'in_progress',
  abandonment_reason text,
  CONSTRAINT matches_finish_order CHECK (
    finished_at IS NULL OR finished_at >= started_at
  )
);

CREATE INDEX matches_room_idx ON public.matches (room_id);
CREATE INDEX matches_winner_idx ON public.matches (winner_user_id);
CREATE INDEX matches_status_idx ON public.matches (status);
CREATE INDEX matches_started_at_idx ON public.matches (started_at DESC);

-- At most one in-progress match per room
CREATE UNIQUE INDEX matches_one_active_per_room_uidx
  ON public.matches (room_id)
  WHERE status = 'in_progress';

-- ---------------------------------------------------------------------------
-- match_players
-- ---------------------------------------------------------------------------
CREATE TABLE public.match_players (
  match_id uuid NOT NULL REFERENCES public.matches (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  seat_number integer NOT NULL CHECK (seat_number >= 0 AND seat_number <= 3),
  result public.match_result,
  score integer,
  PRIMARY KEY (match_id, user_id),
  CONSTRAINT match_players_unique_seat UNIQUE (match_id, seat_number)
);

CREATE INDEX match_players_user_idx ON public.match_players (user_id);

-- ---------------------------------------------------------------------------
-- Helper: is participant of room (for RLS)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_room_participant(p_room_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.room_players rp
    WHERE rp.room_id = p_room_id
      AND rp.user_id = p_user_id
      AND rp.left_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.is_match_participant(p_match_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.match_players mp
    WHERE mp.match_id = p_match_id
      AND mp.user_id = p_user_id
  );
$$;

-- Service-role / trusted server completes matches idempotently
CREATE OR REPLACE FUNCTION public.complete_match(
  p_match_id uuid,
  p_winner_user_id uuid,
  p_status public.match_status DEFAULT 'completed',
  p_abandonment_reason text DEFAULT NULL
)
RETURNS public.matches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m public.matches;
  mp RECORD;
BEGIN
  SELECT * INTO m FROM public.matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match not found';
  END IF;

  -- Idempotent: already finished
  IF m.status <> 'in_progress' THEN
    RETURN m;
  END IF;

  UPDATE public.matches
  SET
    status = p_status,
    winner_user_id = p_winner_user_id,
    finished_at = now(),
    abandonment_reason = p_abandonment_reason
  WHERE id = p_match_id
  RETURNING * INTO m;

  UPDATE public.game_rooms
  SET
    status = CASE
      WHEN p_status = 'abandoned' THEN 'abandoned'::public.room_status
      ELSE 'finished'::public.room_status
    END,
    finished_at = now()
  WHERE id = m.room_id;

  FOR mp IN
    SELECT * FROM public.match_players WHERE match_id = p_match_id
  LOOP
    UPDATE public.match_players
    SET result = CASE
      WHEN p_status = 'abandoned' AND (p_winner_user_id IS NULL OR mp.user_id <> p_winner_user_id)
        THEN 'abandoned'::public.match_result
      WHEN p_winner_user_id IS NOT NULL AND mp.user_id = p_winner_user_id
        THEN 'win'::public.match_result
      WHEN p_winner_user_id IS NOT NULL
        THEN 'loss'::public.match_result
      ELSE 'draw'::public.match_result
    END
    WHERE match_id = p_match_id AND user_id = mp.user_id;

    UPDATE public.profiles
    SET
      games_played = games_played + 1,
      games_won = games_won + CASE
        WHEN p_winner_user_id IS NOT NULL AND mp.user_id = p_winner_user_id THEN 1
        ELSE 0
      END
    WHERE id = mp.user_id;
  END LOOP;

  RETURN m;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_match(uuid, uuid, public.match_status, text) FROM PUBLIC;
-- Granted to service_role only via Supabase defaults / explicit grant:
GRANT EXECUTE ON FUNCTION public.complete_match(uuid, uuid, public.match_status, text) TO service_role;
