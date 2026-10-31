import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { Listen, Platform, Proc, ProcessList } from './types';

// LC_ALL=C: `lstart` sai no idioma do sistema e só o inglês é entendido por Date.parse.
// Duas listagens porque `comm` e `args` podem ter espaços e não dá para separá-los na mesma linha.
const QUERY = `
export LC_ALL=C
echo '#procs'; ps -eo pid=,ppid=,lstart=,comm=
echo '#args'; ps -ww -eo pid=,args=
echo '#listen'; ss -ltnpH
`;

const KILL = `
tree() { for c in $(ps -o pid= --ppid "$1"); do tree "$c"; done; echo "$1"; }
pids=$(tree "$1")
kill -TERM $pids 2>/dev/null
sleep 1
kill -KILL $pids 2>/dev/null
exit 0
`;

/** Mesmo formato do parser do mod (mods/apps-rodando/hooks/platform.ts). */
function parseQuery(stdout: string): ProcessList {
  let section = '';
  const procs = new Map<number, Proc>();
  const listen: Listen[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('#')) {
      section = line.slice(1);
    } else if (section === 'procs') {
      const m = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line);
      if (!m) continue;
      const started = Date.parse(m[3]);
      procs.set(Number(m[1]), {
        ProcessId: Number(m[1]),
        ParentProcessId: Number(m[2]),
        Name: m[4],
        CommandLine: null,
        Created: Number.isNaN(started) ? null : new Date(started).toISOString()
      });
    } else if (section === 'args') {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      const p = m && procs.get(Number(m[1]));
      if (m && p) p.CommandLine = m[2];
    } else if (section === 'listen') {
      // LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=3),("node",pid=13,fd=3))
      const port = Number(line.trim().split(/\s+/)[3]?.split(':').pop());
      if (!port) continue;
      for (const m of line.matchAll(/pid=(\d+)/g)) listen.push({ LocalPort: port, OwningProcess: Number(m[1]) });
    }
  }
  return { procs: [...procs.values()], listen };
}

/** O nome vai para um caminho de arquivo e para um script `sh`. */
const safeName = (name: string) => name.replace(/[^\w.-]/g, '_');

const signalFile = (claudeDir: string, name: string) => path.join(claudeDir, `${safeName(name)}.signal`);

let notified = false;

export const linux: Platform = {
  defaultShell: () => process.env.SHELL || '/bin/bash',

  queryProcesses: () => new Promise((resolve, reject) => {
    execFile('sh', ['-c', QUERY], { maxBuffer: 32 * 1024 * 1024, timeout: 20_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  }),

  parseProcesses: parseQuery,

  killTree: (pid) => new Promise((resolve) => {
    execFile('sh', ['-c', KILL, 'sh', String(pid)], () => resolve());
  }),

  // Sem named pipes: o hook grava o JSON que recebe do Claude Code num arquivo, sem depender
  // de nc/socat, e toda janela vê o sinal. O `cwd` do JSON diz de qual projeto ele veio.
  listenSignals(name, onSignal) {
    const claudeDir = path.join(os.homedir(), '.claude');
    const file = signalFile(claudeDir, name);
    const base = path.basename(file);
    let watcher: fs.FSWatcher | undefined;
    try {
      fs.mkdirSync(claudeDir, { recursive: true });
      watcher = fs.watch(claudeDir, (_event, changed) => {
        if (changed !== base) return;
        let cwd: string | undefined;
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (typeof parsed?.cwd === 'string') cwd = parsed.cwd;
        } catch {
          return; // arquivo removido entre o evento e a leitura: não é um sinal
        }
        onSignal(cwd);
      });
    } catch (e) {
      console.error('[ClaudeCodeFlash] watch falhou:', e);
    }
    return { dispose: () => watcher?.close() };
  },

  // O Wayland não deixa um app piscar a própria janela; o equivalente é uma notificação,
  // uma por vez e só com a janela sem foco.
  startAttention() {
    if (notified || vscode.window.state.focused) return;
    notified = true;
    const child = spawn('notify-send', ['--app-name=Claude Code', 'Claude Code', 'O Claude terminou ou precisa de você.'], {
      stdio: 'ignore',
      // Sem o endereço do D-Bus no ambiente, o notify-send falha; este é o caminho padrão da sessão.
      env: { DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${os.userInfo().uid}/bus`, ...process.env }
    });
    child.on('error', (e) => console.error('[ClaudeCodeFlash] notify-send falhou:', e));
  },

  stopAttention() {
    notified = false;
  },

  writeHookScript(claudeDir, name) {
    const scriptPath = path.join(claudeDir, 'claude-code-flash-notify.sh');
    const target = signalFile(claudeDir, name);
    // mv: a extensão nunca lê um arquivo pela metade.
    const scriptBody = `#!/bin/sh
f='${target.replace(/'/g, `'\\''`)}'
cat > "$f.$$" && mv -f "$f.$$" "$f"
`;
    fs.writeFileSync(scriptPath, scriptBody, { mode: 0o755 });
    return `sh "${scriptPath}"`;
  }
};
