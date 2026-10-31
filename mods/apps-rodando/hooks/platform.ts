// Tudo o que depende do sistema operacional fica aqui; register.tsx só conhece a interface Platform.
// A extensão do VS Code tem o equivalente em extension/src/platform/.

export type Proc = { ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null; Created: string | null }
export type Listen = { LocalPort: number; OwningProcess: number }
export type Raw = { self: number; procs: Proc[]; listen: Listen[] }

export type Platform = {
  /** Consulta processos, portas em LISTEN e o próprio PID (para achar o CLI desta sessão). */
  queryArgv: readonly string[]
  parseQuery: (stdout: string) => Raw
  /** Encerra o processo e seus subprocessos. */
  killArgv: (pid: number) => readonly string[]
  /** Quem adota um processo cujo pai morreu: subindo a árvore, é o mesmo que não ter pai. */
  isReaper: (p: Proc) => boolean
}

const asArray = <T,>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v])

const WINDOWS_QUERY = `
$p = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Created';e={if ($_.CreationDate) { $_.CreationDate.ToString('o') }}})
$l = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess)
@{ self = $PID; procs = $p; listen = $l } | ConvertTo-Json -Depth 3 -Compress
`

export const windows: Platform = {
  queryArgv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY],
  parseQuery: stdout => {
    const raw = JSON.parse(stdout)
    return { self: raw.self, procs: asArray<Proc>(raw.procs), listen: asArray<Listen>(raw.listen) }
  },
  killArgv: pid => ['taskkill', '/PID', String(pid), '/T', '/F'],
  isReaper: () => false,
}

// LC_ALL=C: `lstart` sai no idioma do sistema e só o inglês é entendido por Date.parse.
// Duas listagens porque `comm` e `args` podem ter espaços e não dá para separá-los na mesma linha.
const LINUX_QUERY = `
export LC_ALL=C
echo "#self $$"
echo '#procs'; ps -eo pid=,ppid=,lstart=,comm=
echo '#args'; ps -ww -eo pid=,args=
echo '#listen'; ss -ltnpH
`

const LINUX_KILL = `
tree() { for c in $(ps -o pid= --ppid "$1"); do tree "$c"; done; echo "$1"; }
pids=$(tree "$1")
kill -TERM $pids 2>/dev/null
sleep 1
kill -KILL $pids 2>/dev/null
exit 0
`

export function parseLinuxQuery(stdout: string): Raw {
  let self = 0
  let section = ''
  const procs = new Map<number, Proc>()
  const listen: Listen[] = []
  for (const line of stdout.split('\n')) {
    if (line.startsWith('#')) {
      const [tag, value] = line.slice(1).split(' ')
      section = tag!
      if (tag === 'self') self = Number(value)
    } else if (section === 'procs') {
      const m = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line)
      if (!m) continue
      const started = Date.parse(m[3]!)
      procs.set(Number(m[1]), {
        ProcessId: Number(m[1]),
        ParentProcessId: Number(m[2]),
        Name: m[4]!,
        CommandLine: null,
        Created: Number.isNaN(started) ? null : new Date(started).toISOString(),
      })
    } else if (section === 'args') {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line)
      const p = m && procs.get(Number(m[1]))
      if (p) p.CommandLine = m[2]!
    } else if (section === 'listen') {
      // LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=3),("node",pid=13,fd=3))
      const port = Number(line.trim().split(/\s+/)[3]?.split(':').pop())
      if (!port) continue
      for (const m of line.matchAll(/pid=(\d+)/g)) listen.push({ LocalPort: port, OwningProcess: Number(m[1]) })
    }
  }
  return { self, procs: [...procs.values()], listen }
}

export const linux: Platform = {
  queryArgv: ['sh', '-c', LINUX_QUERY],
  parseQuery: parseLinuxQuery,
  killArgv: pid => ['sh', '-c', LINUX_KILL, 'sh', String(pid)],
  // O pai de um órfão vira o PID 1 ou o `systemd --user` da sessão.
  isReaper: p => p.ProcessId === 1 || p.Name === 'systemd' || p.Name === 'init',
}

/** O Windows sempre define OS=Windows_NT; o engine não expõe a plataforma de outro jeito. */
export const pickPlatform = (os: string | undefined): Platform => (os === 'Windows_NT' ? windows : linux)
