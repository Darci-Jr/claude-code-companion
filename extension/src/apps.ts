import * as vscode from 'vscode';
import { platform, Proc, Listen } from './platform';

export interface AppInfo {
  pid: number;
  name: string;
  commandLine: string;
  ports: number[];
  startedAt: number | null;
  /** O processo do Claude que o originou já encerrou — o app ficou rodando sozinho. */
  orphan: boolean;
}

export interface AppsSnapshot {
  apps: AppInfo[];
  error: string | null;
  fetchedAt: number | null;
}

const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'fish', 'powershell', 'pwsh']);

/** Nome do processo sem a extensão do Windows, para comparar igual nos dois sistemas. */
const baseName = (p: Proc) => p.Name.toLowerCase().replace(/\.exe$/, '');

/**
 * Servidores locais que o Claude Code subiu: processos com porta TCP em LISTEN que
 * descendem de um shell de ferramenta (Bash/PowerShell) de um processo do CLI `claude`.
 * Servidores MCP (cmd /c npx …) e o app desktop do Claude (também claude.exe) ficam de fora.
 * PIDs já vistos continuam listados se o Claude encerrar (órfãos), enquanto escutarem.
 */
export class AppsService implements vscode.Disposable {
  private snapshot: AppsSnapshot = { apps: [], error: null, fetchedAt: null };
  private known = new Map<number, string | null>(); // pid → Created (evita confundir PID reciclado)
  private listeners = new Set<(s: AppsSnapshot) => void>();
  private pollTimer?: NodeJS.Timeout;
  private running = false;

  start() {
    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), 15_000);
  }

  dispose() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.listeners.clear();
  }

  onChange(fn: (s: AppsSnapshot) => void): vscode.Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  getSnapshot(): AppsSnapshot {
    return this.snapshot;
  }

  refresh() {
    if (this.running) return;
    this.running = true;
    platform.queryProcesses().then(
      (stdout) => {
        this.running = false;
        try {
          const raw = platform.parseProcesses(stdout);
          this.emit({ apps: this.compute(raw.procs, raw.listen), error: null, fetchedAt: Date.now() });
        } catch (e: any) {
          this.emit({ ...this.snapshot, error: `resposta inválida: ${e.message}` });
        }
      },
      (err) => {
        this.running = false;
        this.emit({ ...this.snapshot, error: `falha ao listar processos: ${err.message}` });
      });
  }

  /** Encerra o processo e toda a sua árvore. */
  async kill(pid: number): Promise<void> {
    await platform.killTree(pid);
    this.known.delete(pid);
    this.refresh();
  }

  private compute(procs: Proc[], listen: Listen[]): AppInfo[] {
    const byId = new Map(procs.map((p) => [p.ProcessId, p]));
    const isToolShell = (p: Proc) => {
      const name = baseName(p);
      // A ferramenta PowerShell entra como `cmd /c chcp 65001 & powershell …`; MCPs como `cmd /c npx …`.
      return SHELLS.has(name) || (name === 'cmd' && /powershell|pwsh|bash/i.test(p.CommandLine || ''));
    };
    const isClaudeCli = (p: Proc) => {
      const cmd = p.CommandLine || '';
      // O app desktop (AnthropicClaude\…\claude.exe) e seus subprocessos Electron não contam.
      if (/AnthropicClaude/i.test(cmd) || /--type=/.test(cmd)) return false;
      // Um shell cujo comando só menciona "claude-code" (um caminho, por exemplo) não é o CLI.
      if (isToolShell(p)) return false;
      return baseName(p) === 'claude' || /claude-code/i.test(cmd);
    };

    /** Sobe a árvore: true se algum ancestral é um shell de ferramenta filho direto do CLI. */
    const spawnedByClaude = (pid: number) => {
      let cur = byId.get(pid);
      for (let depth = 0; cur && depth < 32; depth++) {
        const parent = byId.get(cur.ParentProcessId);
        if (!parent) return false;
        if (isClaudeCli(parent)) return isToolShell(cur);
        cur = parent;
      }
      return false;
    };

    const ports = new Map<number, Set<number>>();
    for (const l of listen) {
      if (!ports.has(l.OwningProcess)) ports.set(l.OwningProcess, new Set());
      ports.get(l.OwningProcess)!.add(l.LocalPort);
    }

    const apps: AppInfo[] = [];
    const nextKnown = new Map<number, string | null>();
    for (const [pid, set] of ports) {
      const p = byId.get(pid);
      if (!p) continue;
      const fromClaude = spawnedByClaude(pid);
      const wasKnown = this.known.has(pid) && this.known.get(pid) === p.Created;
      if (!fromClaude && !wasKnown) continue;
      nextKnown.set(pid, p.Created);
      apps.push({
        pid,
        name: p.Name,
        commandLine: p.CommandLine || p.Name,
        ports: [...set].sort((a, b) => a - b),
        startedAt: p.Created ? Date.parse(p.Created) : null,
        orphan: !fromClaude
      });
    }
    this.known = nextKnown;
    return apps.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  private emit(s: AppsSnapshot) {
    this.snapshot = s;
    for (const fn of this.listeners) {
      try { fn(s); } catch (e) { console.error('[Companion] apps listener falhou:', e); }
    }
  }
}
