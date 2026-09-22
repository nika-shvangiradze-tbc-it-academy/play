/**
 * Lightweight canvas fireworks + confetti for Nardi end-game.
 * No framework dependency; call destroy() to cancel rAF and clear timers.
 */

export type CelebrationMode = 'victory' | 'defeat' | 'none';

export interface CelebrationOptions {
  mode: CelebrationMode;
  /** Full burst (live win) vs quieter/no particles (reconnect / reduced motion). */
  intensity: 'full' | 'subtle' | 'none';
  reducedMotion: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  kind: 'spark' | 'confetti' | 'ember';
  rot: number;
  rotV: number;
  gravity: number;
  drag: number;
}

interface Firework {
  x: number;
  y: number;
  age: number;
  delay: number;
  launched: boolean;
}

const GOLD = ['#e8d5a3', '#d4af6a', '#c99c51', '#f0e0b8', '#b68a46', '#f4e4bc'];
const BURGUNDY = ['#8b3a3a', '#651f31', '#a05058', '#5c2424'];
const CREAM = ['#f4efe4', '#e8dcc8', '#d9c9a8'];
const BRONZE = ['#9a6d31', '#8a6230', '#6e4a22'];

function prefersReducedMotion(): boolean {
  if (typeof globalThis.matchMedia !== 'function') return false;
  return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function pick(arr: string[]): string {
  return arr[(Math.random() * arr.length) | 0]!;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Runs a timed celebration on a full-viewport canvas.
 * Returns a disposer.
 */
export function startEndGameCelebration(
  canvas: HTMLCanvasElement,
  options: CelebrationOptions,
): () => void {
  const reduced = options.reducedMotion || prefersReducedMotion();
  const intensity = reduced || options.mode !== 'victory' ? 'none' : options.intensity;
  if (intensity === 'none' || options.mode === 'none' || options.mode === 'defeat') {
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    return () => undefined;
  }

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return () => undefined;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let particles: Particle[] = [];
  let fireworks: Firework[] = [];
  let raf = 0;
  let alive = true;
  let start = performance.now();
  const durationMs = intensity === 'full' ? 5200 : 2800;

  const resize = () => {
    dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    w = globalThis.innerWidth;
    h = globalThis.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();

  const area = w * h;
  const scale = clamp(area / (390 * 844), 0.55, 1.35);
  const fireworkCount = Math.round((intensity === 'full' ? 7 : 3) * scale);
  const confettiBudget = Math.round((intensity === 'full' ? 110 : 40) * scale);

  const spawnBurst = (x: number, y: number, count: number) => {
    // Radial firework shell — longer, brighter trails in gold/amber/ivory.
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.35;
      const speed = 2.2 + Math.random() * 5.5;
      const palette = Math.random() < 0.78 ? GOLD : Math.random() < 0.55 ? CREAM : BURGUNDY;
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.8,
        life: 0,
        maxLife: 0.85 + Math.random() * 1.1,
        size: 1.4 + Math.random() * 2.8,
        color: pick(palette),
        kind: 'spark',
        rot: 0,
        rotV: 0,
        gravity: 0.04 + Math.random() * 0.045,
        drag: 0.982,
      });
    }
    // Secondary denser ring for a clearer "explosion" silhouette
    const ring = Math.round(count * 0.45);
    for (let i = 0; i < ring; i++) {
      const angle = (Math.PI * 2 * i) / ring + Math.random() * 0.2;
      const speed = 1.1 + Math.random() * 2.4;
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 0.45 + Math.random() * 0.4,
        size: 1 + Math.random() * 1.6,
        color: pick(GOLD),
        kind: 'spark',
        rot: 0,
        rotV: 0,
        gravity: 0.02,
        drag: 0.97,
      });
    }
    // Soft ember core flash
    for (let i = 0; i < 12; i++) {
      particles.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 1.4,
        vy: (Math.random() - 0.5) * 1.4,
        life: 0,
        maxLife: 0.3 + Math.random() * 0.28,
        size: 4 + Math.random() * 5,
        color: pick(GOLD),
        kind: 'ember',
        rot: 0,
        rotV: 0,
        gravity: 0.01,
        drag: 0.95,
      });
    }
  };

  const spawnConfetti = (n: number) => {
    for (let i = 0; i < n; i++) {
      const palette =
        Math.random() < 0.45 ? GOLD : Math.random() < 0.35 ? BURGUNDY : Math.random() < 0.5 ? CREAM : BRONZE;
      particles.push({
        x: Math.random() * w,
        y: -20 - Math.random() * h * 0.35,
        vx: (Math.random() - 0.5) * 1.6,
        vy: 1.2 + Math.random() * 2.4,
        life: 0,
        maxLife: 2.2 + Math.random() * 2.4,
        size: 2.5 + Math.random() * 3.5,
        color: pick(palette),
        kind: 'confetti',
        rot: Math.random() * Math.PI * 2,
        rotV: (Math.random() - 0.5) * 0.18,
        gravity: 0.028 + Math.random() * 0.02,
        drag: 0.995,
      });
    }
  };

  // Schedule fireworks across the viewport
  for (let i = 0; i < fireworkCount; i++) {
    fireworks.push({
      x: w * (0.12 + Math.random() * 0.76),
      y: h * (0.18 + Math.random() * 0.42),
      age: 0,
      delay: 180 + i * (220 + Math.random() * 280) + Math.random() * 200,
      launched: false,
    });
  }

  // Opening confetti shower
  spawnConfetti(Math.round(confettiBudget * 0.55));
  const lateConfetti = globalThis.setTimeout(() => {
    if (alive) spawnConfetti(Math.round(confettiBudget * 0.45));
  }, 900);

  let last = start;
  const frame = (now: number) => {
    if (!alive) return;
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    const elapsed = now - start;

    ctx.clearRect(0, 0, w, h);

    for (const fw of fireworks) {
      if (!fw.launched && elapsed >= fw.delay) {
        fw.launched = true;
        const burst = Math.round((28 + Math.random() * 18) * scale);
        spawnBurst(fw.x, fw.y, burst);
      }
    }

    const next: Particle[] = [];
    for (const p of particles) {
      p.life += dt;
      if (p.life >= p.maxLife) continue;
      p.vx *= p.drag;
      p.vy = p.vy * p.drag + p.gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.rotV;

      const t = p.life / p.maxLife;
      const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;

      ctx.globalAlpha = clamp(alpha, 0, 1);
      if (p.kind === 'confetti') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size, -p.size * 0.45, p.size * 2, p.size * 0.9);
        ctx.restore();
      } else if (p.kind === 'ember') {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 2);
        g.addColorStop(0, p.color);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      next.push(p);
    }
    particles = next;
    ctx.globalAlpha = 1;

    if (elapsed < durationMs) {
      raf = requestAnimationFrame(frame);
    } else {
      // Soft fade remaining particles for ~0.8s then stop
      if (particles.length && elapsed < durationMs + 900) {
        raf = requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, w, h);
        alive = false;
      }
    }
  };

  raf = requestAnimationFrame(frame);
  globalThis.addEventListener('resize', resize);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    globalThis.clearTimeout(lateConfetti);
    globalThis.removeEventListener('resize', resize);
    ctx.clearRect(0, 0, w, h);
  };
}

export { prefersReducedMotion };
