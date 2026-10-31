import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { UsageService, Snapshot } from './usage';
import { StatusService, StatusSnapshot } from './status';
import { SessionService, SessionSnapshot } from './session';
import { AppsService, AppsSnapshot } from './apps';
import { platform, shellArgs } from './platform';

export class CompanionViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeCodeCompanion.panel';
  private view?: vscode.WebviewView;
  private terminal?: vscode.Terminal;
  private usageDisposable?: vscode.Disposable;
  private statusDisposable?: vscode.Disposable;
  private sessionDisposable?: vscode.Disposable;
  private appsDisposable?: vscode.Disposable;
  private termCloseDisposable?: vscode.Disposable;

  constructor(
    private context: vscode.ExtensionContext,
    private usage: UsageService,
    private status: StatusService,
    private session: SessionService,
    private apps: AppsService
  ) {
    this.termCloseDisposable = vscode.window.onDidCloseTerminal((t) => {
      if (t === this.terminal) {
        this.terminal = undefined;
        this.view?.webview.postMessage({ type: 'terminal-state', open: false });
      }
    });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidDispose(() => {
      this.usageDisposable?.dispose();
      this.statusDisposable?.dispose();
      this.sessionDisposable?.dispose();
      this.appsDisposable?.dispose();
      this.view = undefined;
    });

    this.usageDisposable = this.usage.onChange((s) => this.postUsage(s));
    this.statusDisposable = this.status.onChange((s) => this.postStatus(s));
    this.sessionDisposable = this.session.onChange((s) => this.postSession(s));
    this.appsDisposable = this.apps.onChange((s) => this.postApps(s));
    this.postUsage(this.usage.getSnapshot());
    this.postStatus(this.status.getSnapshot());
    this.postSession(this.session.getSnapshot());
    this.postApps(this.apps.getSnapshot());
    this.postTerminalState();
  }

  private onMessage(msg: any) {
    switch (msg?.type) {
      case 'ready':
        this.postUsage(this.usage.getSnapshot());
        this.postStatus(this.status.getSnapshot());
        this.postSession(this.session.getSnapshot());
        this.postApps(this.apps.getSnapshot());
        this.postTerminalState();
        break;
      case 'refresh-apps':
        this.apps.refresh();
        break;
      case 'app-open':
        if (Number.isInteger(msg.port)) vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${msg.port}`));
        break;
      case 'app-kill':
        if (Number.isInteger(msg.pid)) this.killApp(msg.pid, msg.label);
        break;
      case 'refresh-status':
        this.status.refresh(true);
        this.session.refresh();
        break;
      case 'open-terminal':
        this.openTerminal();
        break;
      case 'focus-terminal':
        this.terminal?.show(false);
        break;
      case 'restart-terminal':
        this.restart();
        break;
      case 'cmd-clear':
        this.clearContext();
        break;
      case 'cmd-rename':
        this.renameSession();
        break;
      case 'cmd-new':
        this.newSession();
        break;
      case 'cmd-resume':
        this.resumeSession();
        break;
    }
  }

  restart() {
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = undefined;
    }
    this.openTerminal();
  }

  /** Nova sessão = reinicia o terminal com `claude` limpo. */
  newSession() {
    this.restart();
  }

  /** Reinicia o terminal com `claude --resume` (o seletor de sessões aparece no terminal). */
  resumeSession() {
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = undefined;
    }
    this.openTerminal('--resume');
  }

  private async killApp(pid: number, label?: string) {
    const ok = await vscode.window.showWarningMessage(
      `Encerrar ${label || 'o processo'} (PID ${pid}) e seus subprocessos?`, { modal: true }, 'Encerrar'
    );
    if (ok === 'Encerrar') await this.apps.kill(pid);
  }

  async clearContext() {
    await this.sendSlashCommand('/clear');
  }

  async renameSession() {
    const name = await vscode.window.showInputBox({
      prompt: 'Novo nome da sessão',
      placeHolder: 'ex.: refatoração do painel'
    });
    if (!name) return;
    await this.sendSlashCommand(`/rename ${name}`);
  }

  /**
   * Injeta um slash command no terminal do Claude Code. Envia o texto e o Enter
   * separadamente (com um pequeno atraso) — mais confiável com o TUI do que
   * sendText com newline embutido.
   */
  private async sendSlashCommand(text: string) {
    const justOpened = !this.terminal;
    if (!this.terminal) this.openTerminal();
    const term = this.terminal;
    if (!term) return;
    term.show(false);
    if (justOpened) {
      // o claude precisa de alguns segundos para subir antes de receber input
      await new Promise((r) => setTimeout(r, 6000));
    }
    term.sendText(text, false);
    await new Promise((r) => setTimeout(r, 300));
    term.sendText('\r', false);
  }

  openTerminal(extraArgs?: string) {
    if (this.terminal && !extraArgs) {
      this.terminal.show(false);
      return;
    }
    const cfg = vscode.workspace.getConfiguration('claudeCodeCompanion');
    const claudeCmd = cfg.get<string>('claudeCommand', 'claude') + (extraArgs ? ` ${extraArgs}` : '');
    const shell = cfg.get<string>('shell', '') || platform.defaultShell();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const args = shellArgs(shell, claudeCmd);
    this.terminal = vscode.window.createTerminal({
      name: 'Claude Code', shellPath: shell, shellArgs: args, cwd, iconPath: new vscode.ThemeIcon('comment-discussion')
    });
    this.terminal.show(false);
    this.postTerminalState();
  }

  private postUsage(s: Snapshot) {
    this.view?.webview.postMessage({ type: 'usage', snapshot: s });
  }
  private postStatus(s: StatusSnapshot) {
    this.view?.webview.postMessage({ type: 'status', snapshot: s });
  }
  private postSession(s: SessionSnapshot) {
    this.view?.webview.postMessage({ type: 'session', snapshot: s });
  }
  private postApps(s: AppsSnapshot) {
    this.view?.webview.postMessage({ type: 'apps', snapshot: s });
  }
  private postTerminalState() {
    this.view?.webview.postMessage({ type: 'terminal-state', open: !!this.terminal });
  }

  dispose() {
    this.terminal?.dispose();
    this.usageDisposable?.dispose();
    this.statusDisposable?.dispose();
    this.sessionDisposable?.dispose();
    this.appsDisposable?.dispose();
    this.termCloseDisposable?.dispose();
    this.view = undefined;
  }

  private html(webview: vscode.Webview): string {
    const htmlPath = path.join(this.context.extensionPath, 'media', 'panel.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const nonce = Math.random().toString(36).slice(2);
    return html.replace(/__NONCE__/g, nonce).replace(/__CSP_SOURCE__/g, webview.cspSource);
  }
}
