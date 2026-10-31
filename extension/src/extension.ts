import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UsageService } from './usage';
import { StatusService, StatusSnapshot } from './status';
import { SessionService, SessionSnapshot } from './session';
import { AppsService } from './apps';
import { CompanionViewProvider } from './panel';
import { platform } from './platform';

let signals: vscode.Disposable | undefined;

/** O sinal veio de uma sessão deste workspace? Sem `cwd` (Windows) não há como distinguir. */
function isForThisWindow(cwd?: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!cwd || !folders?.length) return true;
  return folders.some((f) => cwd === f.uri.fsPath || cwd.startsWith(f.uri.fsPath + path.sep));
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export function activate(context: vscode.ExtensionContext) {
  const cfg = () => vscode.workspace.getConfiguration('claudeCodeFlash');
  const pipeName = () => cfg().get<string>('pipeName', 'claude-code-flash');

  // Cada serviço é isolado: uma falha em start() de um não pode derrubar a ativação inteira
  // (senão status bar, painel e flash caem todos juntos).
  const usage = new UsageService();
  try { usage.start(); } catch (e) { console.error('[Companion] usage.start falhou:', e); }
  const status = new StatusService(context.globalState);
  try { status.start(); } catch (e) { console.error('[Companion] status.start falhou:', e); }
  const session = new SessionService();
  try { session.start(); } catch (e) { console.error('[Companion] session.start falhou:', e); }
  const apps = new AppsService();
  try { apps.start(); } catch (e) { console.error('[Companion] apps.start falhou:', e); }

  const onSignal = (cwd?: string) => {
    if (isForThisWindow(cwd)) platform.startAttention(cfg().get<number>('flashCount', 0));
    try { status.refresh(); session.refresh(); apps.refresh(); } catch {}
  };
  signals = platform.listenSignals(pipeName(), onSignal);
  const provider = new CompanionViewProvider(context, usage, status, session, apps);

  // Status bar (direita → esquerda): janela 5h, semana (7d) e contexto da sessão atual.
  const fiveHourItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
  fiveHourItem.command = 'claudeCodeCompanion.openPanel';
  const weekItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  weekItem.command = 'claudeCodeCompanion.openPanel';
  const ctxItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  ctxItem.command = 'claudeCodeCompanion.openPanel';
  const cacheItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  cacheItem.command = 'claudeCodeCompanion.openPanel';

  const thresholdBg = (pct: number) =>
    pct >= 95 ? new vscode.ThemeColor('statusBarItem.errorBackground') :
    pct >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

  const renderLimit = (s: StatusSnapshot) => {
    // Nota de desatualização quando o último fetch falhou (ex.: 429) mas há dados antigos.
    const staleNote = s.error && s.dataAt
      ? `\n\n⚠ ${s.error} — mostrando dados de ${new Date(s.dataAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';

    if (!s.fiveHour) {
      fiveHourItem.text = '$(pulse) 5h —';
      fiveHourItem.tooltip = s.error ? `Claude Code: ${s.error}` : 'Claude Code: aguardando dados de uso';
      fiveHourItem.backgroundColor = undefined;
    } else {
      const p5 = s.fiveHour.utilization;
      fiveHourItem.text = `$(pulse) 5h ${p5.toFixed(0)}%${s.error ? ' $(warning)' : ''}`;
      fiveHourItem.tooltip = new vscode.MarkdownString([
        `**Claude Code — janela de 5h**`, ``,
        `${p5.toFixed(1)}% usado · reseta ${new Date(s.fiveHour.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      ].join('\n\n') + staleNote);
      fiveHourItem.backgroundColor = thresholdBg(p5);
    }
    fiveHourItem.show();

    if (!s.sevenDay) {
      weekItem.hide();
    } else {
      const p7 = s.sevenDay.utilization;
      weekItem.text = `$(calendar) 7d ${p7.toFixed(0)}%`;
      const lines = [
        `**Claude Code — semana (7 dias)**`, ``,
        `${p7.toFixed(1)}% usado · reseta ${new Date(s.sevenDay.resetsAt).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
      ];
      if (s.extraUsage?.isEnabled && s.extraUsage.usedCredits != null) {
        lines.push(`Créditos extras: ${s.extraUsage.usedCredits.toFixed(2)}${s.extraUsage.monthlyLimit ? ` / ${s.extraUsage.monthlyLimit}` : ''} ${s.extraUsage.currency || 'USD'}`);
      }
      weekItem.tooltip = new vscode.MarkdownString(lines.join('\n\n') + staleNote);
      weekItem.backgroundColor = thresholdBg(p7);
      weekItem.show();
    }
  };

  const renderCtx = (s: SessionSnapshot) => {
    if (!s.sessionId) {
      ctxItem.text = '$(database) ctx: —';
      ctxItem.tooltip = 'Nenhuma sessão do Claude Code detectada neste workspace';
      ctxItem.backgroundColor = undefined;
    } else {
      ctxItem.text = `$(database) ${fmtTokens(s.contextTokens)} (${s.contextPct.toFixed(0)}%)`;
      ctxItem.tooltip = new vscode.MarkdownString([
        `**Sessão atual** \`${s.sessionId.slice(0, 8)}\``, ``,
        `Contexto: ${fmtTokens(s.contextTokens)} / ${fmtTokens(s.contextWindow)} tokens (${s.contextPct.toFixed(1)}%)`,
        `Custo estimado da sessão: $${s.costUSD.toFixed(2)}`,
        `Turnos: ${s.turns} · Modelo: ${s.model || '—'}`
      ].join('\n\n'));
      ctxItem.backgroundColor =
        s.contextPct >= 90 ? new vscode.ThemeColor('statusBarItem.errorBackground') :
        s.contextPct >= 75 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    }
    ctxItem.show();
  };

  // Relógio do cache de prompt: contagem regressiva desde a última interação da sessão.
  // Re-renderiza a cada 30s mesmo sem dados novos (o tempo passa sozinho).
  let lastSessionSnap = session.getSnapshot();
  const renderCache = () => {
    const s = lastSessionSnap;
    if (!s.sessionId || !s.cacheExpiresAt) { cacheItem.hide(); return; }
    const remaining = s.cacheExpiresAt - Date.now();
    if (remaining <= 0) {
      cacheItem.text = '$(history) cache frio';
      cacheItem.tooltip = new vscode.MarkdownString(
        '**Cache de prompt expirado**\n\nO próximo turno vai reprocessar o contexto inteiro (custo cheio em vez de 0,1×).'
      );
      cacheItem.backgroundColor = undefined;
    } else {
      const min = Math.ceil(remaining / 60_000);
      cacheItem.text = `$(history) ${min}min`;
      cacheItem.tooltip = new vscode.MarkdownString([
        `**Cache de prompt (TTL 1h)**`, ``,
        `Expira às ${new Date(s.cacheExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} se não houver interação.`,
        `Cada turno renova o prazo — interagir antes mantém o contexto a 0,1× do custo.`
      ].join('\n\n'));
      cacheItem.backgroundColor = min <= 10 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    }
    cacheItem.show();
  };
  const cacheTick = setInterval(renderCache, 30_000);

  renderLimit(status.getSnapshot());
  renderCtx(session.getSnapshot());
  renderCache();

  context.subscriptions.push(
    usage,
    status,
    session,
    apps,
    fiveHourItem,
    weekItem,
    ctxItem,
    cacheItem,
    { dispose: () => clearInterval(cacheTick) },
    status.onChange(renderLimit),
    session.onChange((s) => { lastSessionSnap = s; renderCtx(s); renderCache(); }),
    vscode.window.registerWebviewViewProvider(CompanionViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('claudeCodeCompanion.openPanel', () =>
      vscode.commands.executeCommand('workbench.view.extension.claudeCodeCompanion')
    ),
    vscode.commands.registerCommand('claudeCodeCompanion.restartTerminal', () => provider.restart()),
    vscode.commands.registerCommand('claudeCodeCompanion.refreshStatus', () => { status.refresh(true); session.refresh(); }),
    vscode.commands.registerCommand('claudeCodeCompanion.newSession', () => provider.newSession()),
    vscode.commands.registerCommand('claudeCodeCompanion.resumeSession', () => provider.resumeSession()),
    vscode.commands.registerCommand('claudeCodeCompanion.renameSession', () => provider.renameSession()),
    vscode.commands.registerCommand('claudeCodeCompanion.clearContext', () => provider.clearContext()),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) platform.stopAttention();
    }),
    vscode.commands.registerCommand('claudeCodeFlash.flashNow', async () => {
      const secs = 5;
      for (let i = secs; i > 0; i--) {
        vscode.window.setStatusBarMessage(`Claude Code Flash: piscando em ${i}s — minimize a janela`, 1000);
        await new Promise((r) => setTimeout(r, 1000));
      }
      platform.startAttention(cfg().get<number>('flashCount', 0));
    }),
    vscode.commands.registerCommand('claudeCodeFlash.installHooks', installHooks),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeFlash.pipeName')) {
        signals?.dispose();
        signals = platform.listenSignals(pipeName(), onSignal);
      }
    }),
    { dispose: stopAll }
  );
}

export function deactivate() {
  stopAll();
}

function stopAll() {
  signals?.dispose();
  signals = undefined;
  platform.stopAttention();
}

async function installHooks() {
  const home = os.homedir();
  const settingsPath = path.join(home, '.claude', 'settings.json');
  let settings: any = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`Não consegui ler ${settingsPath}: ${e.message}`);
    return;
  }

  const pipeName = vscode.workspace.getConfiguration('claudeCodeFlash').get<string>('pipeName', 'claude-code-flash');
  let cmd: string;
  try { cmd = platform.writeHookScript(path.dirname(settingsPath), pipeName); } catch (e: any) {
    vscode.window.showErrorMessage(`Falha ao gravar o script do hook: ${e.message}`);
    return;
  }

  settings.hooks = settings.hooks || {};
  for (const evt of ['Stop', 'Notification']) {
    const list = (settings.hooks[evt] = settings.hooks[evt] || []);
    const already = list.some((g: any) =>
      Array.isArray(g?.hooks) && g.hooks.some((h: any) => typeof h?.command === 'string' && (h.command.includes(pipeName) || h.command.includes('claude-code-flash-notify')))
    );
    if (!already) {
      list.push({ matcher: '', hooks: [{ type: 'command', command: cmd }] });
    }
  }

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    vscode.window.showInformationMessage(`Hooks instalados em ${settingsPath}. Reinicie sessões do Claude Code para ativar.`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Falha ao gravar ${settingsPath}: ${e.message}`);
  }
}
