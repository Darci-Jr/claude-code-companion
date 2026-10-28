import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as vscode from 'vscode';

export interface StatusSnapshot {
  fiveHour: { utilization: number; resetsAt: string } | null;
  sevenDay: { utilization: number; resetsAt: string } | null;
  extraUsage?: { isEnabled: boolean; utilization: number | null; usedCredits: number | null; monthlyLimit: number | null; currency: string | null } | null;
  fetchedAt: number;
  /** Quando os dados (fiveHour/sevenDay) foram obtidos com sucesso pela última vez. */
  dataAt?: number;
  error?: string;
}

function readCredentials(): { accessToken: string; refreshToken: string; expiresAt: number } | null {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const c = raw?.claudeAiOauth;
    if (!c?.accessToken) return null;
    return { accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt };
  } catch {
    return null;
  }
}

function httpGetJson(url: string, token: string): Promise<{ status: number; body: string; retryAfter?: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: 'GET', host: u.host, path: u.pathname + u.search,
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code-companion/0.4.0',
        'Accept': 'application/json'
      }
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        const ra = parseInt(String(res.headers['retry-after'] || ''), 10);
        resolve({ status: res.statusCode || 0, body: buf, retryAfter: isNaN(ra) ? undefined : ra });
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const POLL_INTERVAL_MS = 10 * 60_000;   // poll de fundo a cada 10 min
const MIN_REFRESH_GAP_MS = 5 * 60_000;  // refreshes por sinal (hooks) no máx. a cada 5 min
const DEFAULT_BACKOFF_MS = 15 * 60_000; // espera após 429 sem retry-after

export class StatusService implements vscode.Disposable {
  private last: StatusSnapshot = { fiveHour: null, sevenDay: null, fetchedAt: 0 };
  private listeners = new Set<(s: StatusSnapshot) => void>();
  private interval?: NodeJS.Timeout;
  private fetching = false;
  private lastAttempt = 0;
  private backoffUntil = 0;

  /** `memento` (globalState) preserva o último snapshot entre reloads da janela. */
  constructor(private memento?: vscode.Memento) {}

  start() {
    const saved = this.memento?.get<StatusSnapshot>('statusSnapshot');
    if (saved?.fiveHour) {
      this.last = { ...saved, error: undefined };
    }
    this.refresh(true);
    this.interval = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
  }

  dispose() {
    if (this.interval) clearInterval(this.interval);
    this.listeners.clear();
  }

  onChange(fn: (s: StatusSnapshot) => void): vscode.Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  getSnapshot(): StatusSnapshot { return this.last; }

  /**
   * `force` (botão/comando do usuário) ignora o intervalo mínimo entre chamadas,
   * mas ninguém ignora o backoff imposto por um 429.
   */
  async refresh(force = false): Promise<void> {
    if (this.fetching) return;
    const now = Date.now();
    if (now < this.backoffUntil) return;
    if (!force && now - this.lastAttempt < MIN_REFRESH_GAP_MS) return;
    this.lastAttempt = now;
    this.fetching = true;
    try {
      const cred = readCredentials();
      if (!cred) {
        this.last = { ...this.last, fetchedAt: Date.now(), error: 'Credenciais não encontradas em ~/.claude/.credentials.json' };
        this.emit();
        return;
      }
      const resp = await httpGetJson('https://api.anthropic.com/api/oauth/usage', cred.accessToken);
      if (resp.status === 401) {
        this.last = { ...this.last, fetchedAt: Date.now(), error: 'Token expirado — rode `claude` para renovar.' };
        this.emit();
        return;
      }
      if (resp.status === 429) {
        const waitMs = resp.retryAfter ? resp.retryAfter * 1000 : DEFAULT_BACKOFF_MS;
        this.backoffUntil = Date.now() + waitMs;
        this.last = { ...this.last, fetchedAt: Date.now(), error: `Rate limit (429) — nova tentativa em ${Math.ceil(waitMs / 60_000)} min` };
        this.emit();
        return;
      }
      if (resp.status !== 200) {
        this.last = { ...this.last, fetchedAt: Date.now(), error: `HTTP ${resp.status}` };
        this.emit();
        return;
      }
      let data: any;
      try { data = JSON.parse(resp.body); } catch {
        this.last = { ...this.last, fetchedAt: Date.now(), error: 'Resposta inválida' };
        this.emit();
        return;
      }
      this.last = {
        fiveHour: data?.five_hour ? { utilization: data.five_hour.utilization, resetsAt: data.five_hour.resets_at } : null,
        sevenDay: data?.seven_day ? { utilization: data.seven_day.utilization, resetsAt: data.seven_day.resets_at } : null,
        extraUsage: data?.extra_usage ? {
          isEnabled: !!data.extra_usage.is_enabled,
          utilization: data.extra_usage.utilization ?? null,
          usedCredits: data.extra_usage.used_credits ?? null,
          monthlyLimit: data.extra_usage.monthly_limit ?? null,
          currency: data.extra_usage.currency ?? null
        } : null,
        fetchedAt: Date.now(),
        dataAt: Date.now(),
        error: undefined
      };
      this.memento?.update('statusSnapshot', this.last);
      this.emit();
    } catch (e: any) {
      this.last = { ...this.last, fetchedAt: Date.now(), error: e?.message || 'erro de rede' };
      this.emit();
    } finally {
      this.fetching = false;
    }
  }

  private emit() {
    for (const fn of this.listeners) {
      try { fn(this.last); } catch (e) { console.error('[StatusService] listener:', e); }
    }
  }
}
