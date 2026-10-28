import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

// Preços por 1M tokens (USD). Cache write: 1.25x (5min) / 2x (1h); cache read: 0.1x do input.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-fable-5':    { input: 10, output: 50 },
  'claude-opus-4':     { input: 5,  output: 25 },
  'claude-sonnet-4-6': { input: 3,  output: 15 },
  'claude-haiku-4-5':  { input: 1,  output: 5 }
};

export function priceFor(model: string) {
  const key = Object.keys(PRICING).find(k => model?.startsWith(k));
  return key ? PRICING[key] : PRICING['claude-sonnet-4-6'];
}

// Calcula o custo de um bloco `usage` do transcript, diferenciando cache 5min/1h quando disponível.
export function costOf(u: any, model: string): number {
  const p = priceFor(model);
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cw5m = u.cache_creation?.ephemeral_5m_input_tokens;
  const cw1h = u.cache_creation?.ephemeral_1h_input_tokens;
  const cacheWriteCost = (cw5m != null || cw1h != null)
    ? (cw5m || 0) * p.input * 1.25 + (cw1h || 0) * p.input * 2
    : (u.cache_creation_input_tokens || 0) * p.input * 1.25;
  return (input * p.input + output * p.output + cacheRead * p.input * 0.1 + cacheWriteCost) / 1_000_000;
}

export interface Turn {
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  costUSD: number;
}

export interface Snapshot {
  fiveHour: {
    startedAt: number | null;
    endsAt: number | null;
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    totalTokens: number;
    costUSD: number;
    turns: number;
  };
  weekly: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    totalTokens: number;
    costUSD: number;
    turns: number;
  };
  alert: 'none' | 'approaching' | 'reached';
  alertMessage?: string;
  lastUpdated: number;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class UsageService implements vscode.Disposable {
  private projectsDir = path.join(os.homedir(), '.claude', 'projects');
  private fileOffsets = new Map<string, number>();
  private turns: Turn[] = [];
  private alert: Snapshot['alert'] = 'none';
  private alertMessage?: string;
  private watcher?: fs.FSWatcher;
  private listeners = new Set<(s: Snapshot) => void>();
  private debounceTimer?: NodeJS.Timeout;

  start() {
    this.scanAll();
    try {
      this.watcher = fs.watch(this.projectsDir, { recursive: true }, () => this.scheduleScan());
    } catch (e) {
      console.error('[UsageService] watch failed:', e);
    }
  }

  dispose() {
    this.watcher?.close();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.listeners.clear();
  }

  onChange(fn: (s: Snapshot) => void): vscode.Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  getSnapshot(): Snapshot {
    return this.computeSnapshot();
  }

  private scheduleScan() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.scanAll(), 500);
  }

  private scanAll() {
    if (!fs.existsSync(this.projectsDir)) return;
    const files = this.findJsonl(this.projectsDir);
    for (const f of files) this.scanFile(f);
    this.turns.sort((a, b) => a.ts - b.ts);
    this.emit();
  }

  private findJsonl(dir: string): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...this.findJsonl(full));
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
    return out;
  }

  private scanFile(file: string) {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return; }
    const prevOffset = this.fileOffsets.get(file) ?? 0;
    if (stat.size <= prevOffset) return;
    let fd: number;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      // Lê em blocos (não aloca o arquivo inteiro): transcripts podem ter centenas de MB,
      // e um Buffer/string do tamanho todo estoura o limite de string do V8 (~512MB).
      const CHUNK = 4 * 1024 * 1024;
      const chunk = Buffer.alloc(CHUNK);
      let readPos = prevOffset;
      let carry = Buffer.alloc(0); // bytes de uma linha ainda incompleta entre blocos
      let processedBytes = 0;
      const end = stat.size;
      while (readPos < end) {
        const want = Math.min(CHUNK, end - readPos);
        const got = fs.readSync(fd, chunk, 0, want, readPos);
        if (got <= 0) break;
        readPos += got;
        let data = carry.length ? Buffer.concat([carry, chunk.subarray(0, got)]) : chunk.subarray(0, got);
        let nl: number;
        let start = 0;
        while ((nl = data.indexOf(0x0a, start)) !== -1) {
          const lineBuf = data.subarray(start, nl);
          processedBytes += lineBuf.length + 1; // +1 pelo \n
          const line = lineBuf.toString('utf8');
          if (line.trim()) this.processLine(line);
          start = nl + 1;
        }
        carry = data.subarray(start).length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
      }
      // `carry` é a última linha incompleta — não a processamos nem contamos, fica pro próximo scan.
      this.fileOffsets.set(file, prevOffset + processedBytes);
    } finally {
      fs.closeSync(fd);
    }
  }

  private processLine(line: string) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj?.type === 'assistant' && obj?.message?.usage) {
      const u = obj.message.usage;
      const model = obj.message.model || '';
      const input = u.input_tokens || 0;
      const output = u.output_tokens || 0;
      const cw = u.cache_creation_input_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      const cost = costOf(u, model);
      this.turns.push({
        ts: new Date(obj.timestamp).getTime(),
        model, input, output, cacheWrite: cw, cacheRead: cr, costUSD: cost
      });
    }
    // Captura mensagens de alerta de limite (heurística por conteúdo).
    if (obj?.type === 'system' && typeof obj?.content === 'string') {
      const c = obj.content.toLowerCase();
      if (c.includes('usage limit') || c.includes('rate limit')) {
        if (c.includes('approaching')) this.alert = 'approaching';
        else this.alert = 'reached';
        this.alertMessage = obj.content;
      }
    }
  }

  private computeSnapshot(): Snapshot {
    const now = Date.now();
    // Janela de 5h: detecta o início da janela ativa pelo último gap >5h.
    let windowStart: number | null = null;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (now - t.ts > FIVE_HOURS_MS) break;
      const prev = i > 0 ? this.turns[i - 1] : null;
      if (!prev || (t.ts - prev.ts) > FIVE_HOURS_MS) {
        windowStart = t.ts;
        break;
      }
      windowStart = prev.ts; // continua descendo
    }
    const fh = { startedAt: windowStart, endsAt: windowStart ? windowStart + FIVE_HOURS_MS : null,
                 input: 0, output: 0, cacheWrite: 0, cacheRead: 0, totalTokens: 0, costUSD: 0, turns: 0 };
    const wk = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, totalTokens: 0, costUSD: 0, turns: 0 };
    const weekStart = now - SEVEN_DAYS_MS;
    for (const t of this.turns) {
      if (t.ts >= weekStart) {
        wk.input += t.input; wk.output += t.output; wk.cacheWrite += t.cacheWrite;
        wk.cacheRead += t.cacheRead; wk.costUSD += t.costUSD; wk.turns++;
      }
      if (windowStart && t.ts >= windowStart && t.ts <= (windowStart + FIVE_HOURS_MS)) {
        fh.input += t.input; fh.output += t.output; fh.cacheWrite += t.cacheWrite;
        fh.cacheRead += t.cacheRead; fh.costUSD += t.costUSD; fh.turns++;
      }
    }
    fh.totalTokens = fh.input + fh.output + fh.cacheWrite + fh.cacheRead;
    wk.totalTokens = wk.input + wk.output + wk.cacheWrite + wk.cacheRead;
    return {
      fiveHour: fh, weekly: wk,
      alert: this.alert, alertMessage: this.alertMessage,
      lastUpdated: now
    };
  }

  private emit() {
    const snap = this.computeSnapshot();
    for (const fn of this.listeners) {
      try { fn(snap); } catch (e) { console.error('[UsageService] listener error:', e); }
    }
  }
}
