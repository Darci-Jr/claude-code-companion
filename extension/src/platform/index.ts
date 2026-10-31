import * as path from 'path';
import { linux } from './linux';
import { windows } from './windows';
import { Platform } from './types';

export * from './types';

export const platform: Platform = process.platform === 'win32' ? windows : linux;

/** Argumentos para o shell abrir já rodando `command` e continuar aberto quando ele sair. */
export function shellArgs(shell: string, command: string): string[] {
  const name = path.basename(shell).toLowerCase();
  if (name.includes('powershell')) return ['-NoLogo', '-NoExit', '-Command', command];
  // -i para carregar o PATH do rc do usuário, onde costuma estar o `claude`.
  if (/^(bash|sh|dash|zsh|fish)(\.exe)?$/.test(name)) return ['-ic', `${command}; exec '${shell}'`];
  return ['/k', command];
}
