import * as vscode from 'vscode';

export interface Proc {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  CommandLine: string | null;
  Created: string | null;
}

export interface Listen {
  LocalPort: number;
  OwningProcess: number;
}

export interface ProcessList {
  procs: Proc[];
  listen: Listen[];
}

/** Tudo o que depende do sistema operacional; o resto da extensão só conhece esta interface. */
export interface Platform {
  /** Shell do terminal do Claude quando a config `claudeCodeCompanion.shell` está vazia. */
  defaultShell(): string;
  /** Saída crua da consulta de processos e portas em LISTEN. */
  queryProcesses(): Promise<string>;
  parseProcesses(stdout: string): ProcessList;
  /** Encerra o processo e toda a sua árvore. */
  killTree(pid: number): Promise<void>;
  /** Recebe os sinais dos hooks do Claude Code. `cwd` é o da sessão, quando o sistema o informa. */
  listenSignals(name: string, onSignal: (cwd?: string) => void): vscode.Disposable;
  /** Chama a atenção do usuário para a janela do VS Code. */
  startAttention(count: number): void;
  stopAttention(): void;
  /** Grava o script do hook em `claudeDir` e devolve o comando que o executa. */
  writeHookScript(claudeDir: string, name: string): string;
}
