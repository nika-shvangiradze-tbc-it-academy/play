-- =============================================================================
-- Ensure one active membership per user per room
-- Equivalent to UNIQUE(room_id, user_id) for live seats (left_at IS NULL).
-- History rows (left_at set) remain allowed for rejoin / audit.
-- Idempotent: safe if indexes already exist from initial schema.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS room_players_room_user_active_uidx
  ON public.room_players (room_id, user_id)
  WHERE left_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS room_players_room_seat_active_uidx
  ON public.room_players (room_id, seat_number)
  WHERE left_at IS NULL;
