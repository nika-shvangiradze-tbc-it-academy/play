import { Injectable, inject } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import type { MatchHistoryEntry, PaginatedHistory } from '@georgian-games/shared';

@Injectable({ providedIn: 'root' })
export class HistoryService {
  private readonly auth = inject(AuthService);

  async getHistory(page = 1, pageSize = 10): Promise<PaginatedHistory> {
    const userId = this.auth.user()?.id;
    if (!userId) {
      return { items: [], page, pageSize, total: 0, hasMore: false };
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data: mine, error, count } = await this.auth.client
      .from('match_players')
      .select('match_id, seat_number, result, score', { count: 'exact' })
      .eq('user_id', userId)
      .order('match_id', { ascending: false })
      .range(from, to);

    if (error || !mine?.length) {
      return { items: [], page, pageSize, total: count ?? 0, hasMore: false };
    }

    const matchIds = mine.map((m) => m.match_id as string);
    const { data: matches } = await this.auth.client
      .from('matches')
      .select('id, game_type, started_at, finished_at, status, winner_user_id')
      .in('id', matchIds);

    const { data: allPlayers } = await this.auth.client
      .from('match_players')
      .select('match_id, user_id, seat_number')
      .in('match_id', matchIds);

    const opponentIds = [
      ...new Set(
        (allPlayers ?? [])
          .filter((p) => p.user_id !== userId)
          .map((p) => p.user_id as string),
      ),
    ];

    const { data: profiles } = opponentIds.length
      ? await this.auth.client.from('profiles').select('id, username').in('id', opponentIds)
      : { data: [] as Array<{ id: string; username: string }> };

    const profileMap = new Map((profiles ?? []).map((p) => [p.id, p.username]));
    const matchMap = new Map((matches ?? []).map((m) => [m.id as string, m]));

    const items: MatchHistoryEntry[] = mine.map((row) => {
      const match = matchMap.get(row.match_id as string);
      const opponents = (allPlayers ?? [])
        .filter((p) => p.match_id === row.match_id && p.user_id !== userId)
        .map((p) => ({
          user_id: p.user_id as string,
          username: profileMap.get(p.user_id as string) ?? 'Unknown',
          seat_number: p.seat_number as number,
        }));

      return {
        match_id: row.match_id as string,
        game_type: (match?.game_type ?? 'nardi') as MatchHistoryEntry['game_type'],
        started_at: (match?.started_at as string) ?? '',
        finished_at: (match?.finished_at as string | null) ?? null,
        status: (match?.status ?? 'completed') as MatchHistoryEntry['status'],
        result: (row.result as string) ?? '—',
        score: (row.score as number | null) ?? null,
        seat_number: row.seat_number as number,
        winner_user_id: (match?.winner_user_id as string | null) ?? null,
        opponents,
      };
    });

    const total = count ?? items.length;
    return {
      items,
      page,
      pageSize,
      total,
      hasMore: from + items.length < total,
    };
  }
}
