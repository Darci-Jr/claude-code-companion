import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { costOf } from './usage';

export interface SessionSnapshot {
  sessionId: string | null;
  model: string;
  contextTokens: number;
  contextWindow: number;
  contextPct: number;
  costUSD: number;
  outputTokens: number;
  turns: number;
  startedAt: number | null;
  lastActivity: number | null;
  /** Quando o cache de prompt expira se não houver interação (lastActivity + TTL). */
  cacheExpiresAt: number | null;
}

interface FileState {
  offset: number;
  sessionId: string | null;
  model: string;
  contextTokens: number;
  /** Maior contexto observado na sessão — evidência direta da janela (> 200k ⇒ 1M). */
  maxContextTokens: number;
  costUSD: number;
  outputTokens: number;
  turns: number;
  firstTs: number | null;
  lastTs: number | null;
}

const EMPTY: SessionSnapshot = {
  sessionId: null, model: '', contextTokens: 0, contextWindow: 1_000_000, contextPct: 0,
  costUSD: 0, outputTokens: 0, turns: 0, startedAt: null, lastActivity: null, cacheExpiresAt: null
};

/**
 * Acompanha a sessão ativa do Claude Code para o workspace atual, lendo o .jsonl
 * mais recente em ~/.claude/projects/<dir codificado>. O "contexto atual" é a soma
 * input + cache_read + cache_creation da última resposta do assistente.
 */
export class SessionService implements vscode.Disposable {
  private projectDir: string | null = null;
  private files = new Map<string, FileState>();
  private activeFile: string | null = null;
  private watcher?: fs.FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private listeners = new Set<(s: SessionSnapshot) => void>();
  private settingsCache: { mtime: number; model: string } = { mtime: 0, model: '' };

  start() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;
    // Claude Code codifica o cwd trocando todo caractere não alfanumérico por '-'.
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    this.projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
    this.refresh();
    try {
      this.watcher = fs.watch(this.projectDir, () => this.scheduleRefresh());
    } catch {
      // diretório ainda não existe — o poll abaixo cobre quando for criado
    }
    this.pollTimer = setInterval(() => this.refresh(), 30_000);
  }

  dispose() {
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.listeners.clear();
  }

  onChange(fn: (s: SessionSnapshot) => void): vscode.Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  getSnapshot(): SessionSnapshot {
    return this.compute();
  }

  refresh() {
    if (!this.projectDir || !fs.existsSync(this.projectDir)) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(this.projectDir, { withFileTypes: true }); } catch { return; }
    let newest: { file: string; mtime: number } | null = null;
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const full = path.join(this.projectDir, e.name);
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!newest || stat.mtimeMs > newest.mtime) newest = { file: full, mtime: stat.mtimeMs };
    }
    if (!newest) return;
    if (this.activeFile !== newest.file) this.activeFile = newest.file;
    this.scanFile(newest.file);
    this.emit();
  }

  private scheduleRefresh() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.refresh(), 400);
  }

  private scanFile(file: string) {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return; }
    let state = this.files.get(file);
    if (!state) {
      state = { offset: 0, sessionId: null, model: '', contextTokens: 0, maxContextTokens: 0, costUSD: 0, outputTokens: 0, turns: 0, firstTs: null, lastTs: null };
      this.files.set(file, state);
    }
    if (stat.size <= state.offset) return;
    let fd: number;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      const len = stat.size - state.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, state.offset);
      const lines = buf.toString('utf8').split('\n');
      const complete = lines.slice(0, -1);
      let processedBytes = 0;
      for (const line of complete) {
        processedBytes += Buffer.byteLength(line, 'utf8') + 1;
        if (!line.trim()) continue;
        this.processLine(line, state);
      }
      state.offset += processedBytes;
    } finally {
      fs.closeSync(fd);
    }
  }

  private processLine(line: string, state: FileState) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj?.sessionId && !state.sessionId) state.sessionId = obj.sessionId;
    if (obj?.type !== 'assistant' || !obj?.message?.usage) return;
    const model = obj.message.model || '';
    // Mensagens sintéticas são geradas localmente (sem chamada à API) — não têm usage real
    // e sobrescreveriam o modelo/contexto da sessão.
    if (!model || model === '<synthetic>') return;
    const u = obj.message.usage;
    state.costUSD += costOf(u, model);
    state.outputTokens += u.output_tokens || 0;
    state.turns++;
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now();
    if (!state.firstTs) state.firstTs = ts;
    state.lastTs = ts;
    // Sidechains (subagents) têm contexto próprio — contam no custo, mas não no contexto da sessão.
    if (obj.isSidechain === true) return;
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (ctx > 0) {
      state.model = model;
      state.contextTokens = ctx;
      if (ctx > state.maxContextTokens) state.maxContextTokens = ctx;
    }
  }

  /** Modelo salvo em ~/.claude/settings.json (com sufixo [1m] quando aplicável), cacheado por mtime. */
  private settingsModel(): string {
    const p = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      const stat = fs.statSync(p);
      if (stat.mtimeMs !== this.settingsCache.mtime) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        this.settingsCache = { mtime: stat.mtimeMs, model: typeof raw?.model === 'string' ? raw.model : '' };
      }
    } catch { /* sem settings ou JSON inválido — usa o que estiver em cache */ }
    return this.settingsCache.model;
  }

  /**
   * Janela de contexto, em ordem de prioridade:
   * 1. override manual da config (> 0);
   * 2. evidência direta — se a sessão já passou de 200k, a janela só pode ser 1M;
   * 3. Haiku → 200k, a menos que o modelo salvo em ~/.claude/settings.json tenha
   *    sufixo [1m] (o transcript registra só o ID puro);
   * 4. demais modelos (Fable, Opus, Sonnet) → 1M.
   */
  private detectWindow(sessionModel: string, maxContextSeen = 0): number {
    const override = vscode.workspace.getConfiguration('claudeCodeCompanion').get<number>('contextWindow', 0);
    if (override > 0) return override;
    if (maxContextSeen > 200_000) return 1_000_000;
    if (sessionModel.includes('haiku')) {
      const configured = this.settingsModel();
      return configured.includes('haiku') && configured.includes('[1m]') ? 1_000_000 : 200_000;
    }
    return 1_000_000;
  }

  private compute(): SessionSnapshot {
    if (!this.activeFile) return { ...EMPTY, contextWindow: this.detectWindow('') };
    const s = this.files.get(this.activeFile);
    if (!s) return { ...EMPTY, contextWindow: this.detectWindow('') };
    const contextWindow = this.detectWindow(s.model, s.maxContextTokens);
    // O Claude Code grava o cache de prompt com TTL de 1h, renovado a cada uso.
    const ttlMin = vscode.workspace.getConfiguration('claudeCodeCompanion').get<number>('cacheTtlMinutes', 60);
    return {
      sessionId: s.sessionId,
      model: s.model,
      contextTokens: s.contextTokens,
      contextWindow,
      contextPct: contextWindow > 0 ? (s.contextTokens / contextWindow) * 100 : 0,
      costUSD: s.costUSD,
      outputTokens: s.outputTokens,
      turns: s.turns,
      startedAt: s.firstTs,
      lastActivity: s.lastTs,
      cacheExpiresAt: s.lastTs ? s.lastTs + ttlMin * 60_000 : null
    };
  }

  private emit() {
    const snap = this.compute();
    for (const fn of this.listeners) {
      try { fn(snap); } catch (e) { console.error('[SessionService] listener:', e); }
    }
  }
}
