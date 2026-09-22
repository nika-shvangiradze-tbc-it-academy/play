/**
 * Free a TCP listen port before tsx watch / server start (Windows-safe).
 * Avoids EADDRINUSE orphans that accept TCP but never respond to HTTP.
 */
import { execSync } from 'node:child_process';

const port = Number(process.argv[2] || process.env.PORT || 2567);
if (!Number.isFinite(port) || port <= 0) {
  console.error('[free-port] invalid port', port);
  process.exit(1);
}

function pidsListeningOnPort(p) {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano', { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(`:${p}`) || !line.includes('LISTENING')) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }
      return [...pids];
    }
    const out = execSync(`lsof -t -iTCP:${p} -sTCP:LISTEN`, { encoding: 'utf8' });
    return out
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

const pids = pidsListeningOnPort(port).filter((pid) => pid !== process.pid);
if (!pids.length) {
  console.log(`[free-port] :${port} is free`);
  process.exit(0);
}

for (const pid of pids) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    console.log(`[free-port] killed pid=${pid} on :${port}`);
  } catch (err) {
    console.warn(`[free-port] could not kill pid=${pid}`, err instanceof Error ? err.message : err);
  }
}

process.exit(0);
