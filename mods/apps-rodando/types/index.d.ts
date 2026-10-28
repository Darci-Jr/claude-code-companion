export type App = {
  pid: number
  name: string
  commandLine: string
  ports: number[]
  /** CreationDate do processo — distingue um PID reciclado. */
  created: string | null
  /** O shell do Claude que o iniciou já encerrou; o app segue rodando sozinho. */
  orphan: boolean
  /** Subiu desacoplado (Start-Process, `start`): atribuído pela janela de tempo de um comando da sessão. */
  detached: boolean
}

/** Quando um comando Bash/PowerShell desta sessão rodou, em ms desde a época. */
export type CallWindow = { start: number; end: number }

export type Scan = {
  apps: App[]
  checkedAt: number | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'apps-rodando': {
      scan: Shaped<Scan>
      calls: Shaped<CallWindow[]>
      /** PID aguardando o segundo clique de confirmação para encerrar. */
      pendingKill: number | null
    }
  }
}
