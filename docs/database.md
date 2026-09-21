# Database & RLS

## Tables

### profiles
Public player profile linked 1:1 to `auth.users`.  
`username_normalized` enforces case-insensitive uniqueness.

### game_rooms
Private room metadata + invite code. Not publicly listable.

### room_players
Seat occupancy. Partial unique indexes prevent duplicate active seats / users.

### matches / match_players
Durable match outcomes. Created and completed only by the game server.

## Sensitive writes

Clients **cannot**:

- insert/update `game_rooms`, `room_players`, `matches`, `match_players`
- change `games_played` / `games_won` on profiles
- declare winners

Match completion goes through `public.complete_match(...)` (`SECURITY DEFINER`, granted to `service_role`). It is **idempotent**.

## RLS summary

| Table | SELECT | INSERT/UPDATE/DELETE |
|-------|--------|---------------------|
| profiles | authenticated (usernames needed) | own row only; stats immutable from client |
| game_rooms | host or active participant | none (service role) |
| room_players | participants / host | none (service role) |
| matches | match participants | none (service role) |
| match_players | match participants | none (service role) |

### Why `profiles` SELECT `USING (true)` for authenticated?

Signed-in users need usernames for lobby seats and history opponents. Emails/passwords remain in `auth`. Documented intentional read scope — **not** applied to write policies or match tables.

### Invite codes

Clients do not get a broad `SELECT` on all rooms by invite code. Lookup/join is performed via the game server (service role) with rate limiting to reduce brute force.

## Indexes & constraints

- Unique invite codes
- One active `(room_id, user_id)` and `(room_id, seat_number)`
- One `in_progress` match per room
- Unique `(match_id, seat_number)`
