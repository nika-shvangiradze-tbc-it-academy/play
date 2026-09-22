import { Component, inject, OnInit, signal } from '@angular/core';
import { HistoryService } from '../../core/game/history.service';
import type { MatchHistoryEntry } from '@georgian-games/shared';

@Component({
  selector: 'app-history-page',
  standalone: true,
  templateUrl: './history.page.html',
  styleUrl: './history.page.scss',
})
export class HistoryPage implements OnInit {
  private readonly history = inject(HistoryService);

  readonly items = signal<MatchHistoryEntry[]>([]);
  readonly page = signal(1);
  readonly hasMore = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    void this.load(1);
  }

  async load(page: number): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.history.getHistory(page, 10);
      this.items.set(result.items);
      this.page.set(result.page);
      this.hasMore.set(result.hasMore);
    } catch {
      this.error.set('მატჩების ისტორია ვერ ჩაიტვირთა');
    } finally {
      this.loading.set(false);
    }
  }

  next(): void {
    if (this.hasMore()) void this.load(this.page() + 1);
  }

  prev(): void {
    if (this.page() > 1) void this.load(this.page() - 1);
  }

  formatDate(iso: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('ka-GE');
  }

  opponentsLabel(entry: MatchHistoryEntry): string {
    return entry.opponents.map((o) => o.username).join(', ') || '—';
  }

  gameTypeLabel(type: string): string {
    const map: Record<string, string> = {
      nardi: 'ნარდი',
      joker: 'ჯოკერი',
      domino: 'დომინო',
      bura: 'ბურა',
    };
    return map[type.toLowerCase()] ?? type;
  }

  resultLabel(result: string): string {
    const map: Record<string, string> = {
      win: 'მოგება',
      loss: 'წაგება',
      draw: 'ფრე',
      abandoned: 'შეწყვეტილი',
    };
    return map[result.toLowerCase()] ?? result;
  }
}
