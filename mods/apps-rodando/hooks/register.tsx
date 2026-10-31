import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { App, CallWindow, Scan } from '../types'
import { pickPlatform } from './platform'
import type { Listen, Platform, Proc } from './platform'

const PANE = 'apps-rodando'
// Trocar a tag quando os campos de App/Scan mudarem: o valor guardado sobrevive ao reload.
const scan = atom({ plugin: 'apps-rodando', key: 'scan' } as const,
  { apps: [], checkedAt: null, error: null }, { shape: 'scan-2' })
const calls = atom({ plugin: 'apps-rodando', key: 'calls' } as const, [], { shape: 'calls-1' })

// Folga da janela: o processo desacoplado nasce durante o comando, mas o relógio do
// Windows e o do engine podem divergir um pouco.
const SLACK_MS = 2_000
const pendingKill = atom({ plugin: 'apps-rodando', key: 'pendingKill' } as const, null)

const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'fish', 'powershell', 'pwsh'])

/** Nome do processo sem a extensão do Windows, para comparar igual nos dois sistemas. */
const baseName = (p: Proc) => p.Name.toLowerCase().replace(/\.exe$/, '')

const isToolShell = (p: Proc) => {
  const name = baseName(p)
  // A ferramenta PowerShell entra como `cmd /c chcp 65001 & powershell …`; MCPs como `cmd /c npx …`.
  return SHELLS.has(name) || (name === 'cmd' && /powershell|pwsh|bash/i.test(p.CommandLine || ''))
}

const isClaudeCli = (p: Proc) => {
  const cmd = p.CommandLine || ''
  // O app desktop (AnthropicClaude\…\claude.exe) e seus subprocessos Electron não contam.
  if (/AnthropicClaude/i.test(cmd) || /--type=/.test(cmd)) return false
  // Um shell cujo comando só menciona "claude-code" (um caminho, por exemplo) não é o CLI.
  if (isToolShell(p)) return false
  return baseName(p) === 'claude' || /claude-code/i.test(cmd)
}

/** CreationDate em ms. O PowerShell escreve 7 casas de fração; nem todo parser aceita mais que 3. */
const createdMs = (created: string | null) =>
  created ? Date.parse(created.replace(/(\.\d{3})\d+/, '$1')) : NaN

function compute(platform: Platform, self: number, procs: Proc[], listen: Listen[], previous: App[], windows: CallWindow[]): App[] {
  const byId = new Map(procs.map(p => [p.ProcessId, p]))

  // O claude.exe desta sessão: o primeiro ancestral CLI do powershell desta consulta.
  let root: Proc | undefined = byId.get(self)
  for (let i = 0; root && i < 8 && !isClaudeCli(root); i++) root = byId.get(root.ParentProcessId)
  const rootPid = root && isClaudeCli(root) ? root.ProcessId : null

  const inWindow = (p: Proc) => {
    const t = createdMs(p.Created)
    return !Number.isNaN(t) && windows.some(w => t >= w.start - SLACK_MS && t <= w.end + SLACK_MS)
  }

  /**
   * Sobe a árvore a partir do processo:
   * - `here`: chega ao claude.exe da sessão por um shell de ferramenta;
   * - `detached`: a cadeia termina num pai que já morreu (Start-Process, `start`) e o topo
   *   vivo dela nasceu durante um comando desta sessão;
   * - `null`: qualquer outra coisa.
   */
  const origin = (pid: number): 'here' | 'detached' | null => {
    let cur = byId.get(pid)
    for (let depth = 0; cur && depth < 32; depth++) {
      const parent = byId.get(cur.ParentProcessId)
      // PID reciclado: um "pai" mais novo que o filho não é o pai de verdade.
      const parentIsReal = parent && !(createdMs(parent.Created) > createdMs(cur.Created))
      if (!parent || !parentIsReal || platform.isReaper(parent)) return inWindow(cur) ? 'detached' : null
      if (parent.ProcessId === rootPid) return isToolShell(cur) && cur.ProcessId !== self ? 'here' : null
      cur = parent
    }
    return null
  }

  const ports = new Map<number, Set<number>>()
  for (const l of listen) {
    if (!ports.has(l.OwningProcess)) ports.set(l.OwningProcess, new Set())
    ports.get(l.OwningProcess)!.add(l.LocalPort)
  }

  const apps: App[] = []
  for (const [pid, set] of ports) {
    const p = byId.get(pid)
    if (!p) continue
    const found = rootPid !== null ? origin(pid) : null
    const prev = previous.find(a => a.pid === pid && a.created === p.Created)
    if (!found && !prev) continue
    const detached = found === 'detached' || (!found && !!prev?.detached)
    apps.push({
      pid,
      name: p.Name.replace(/\.exe$/i, ''),
      commandLine: p.CommandLine || p.Name,
      ports: [...set].sort((a, b) => a - b),
      created: p.Created,
      // Um desacoplado nunca teve o shell do Claude como pai: não vira "órfão".
      orphan: !found && !detached,
      detached,
    })
  }
  return apps.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
}

let running = false

async function refresh($: EngineInterface) {
  if (running) return
  running = true
  try {
    const previous = (await read($, scan)).apps
    const platform = pickPlatform(await $.env.get('OS'))
    const { exitCode, stdout, stderr } = await $.process.run(platform.queryArgv, { timeoutMs: 20_000 })
    const checkedAt = await $.clock.now()
    if (exitCode !== 0) {
      await update($, scan, s => ({ ...s, checkedAt, error: `consulta falhou: ${stderr.slice(0, 200)}` }))
      return
    }
    const raw = platform.parseQuery(stdout)
    const apps = compute(platform, raw.self, raw.procs, raw.listen, previous, await read($, calls))
    for (const a of apps) {
      if (!previous.some(p => p.pid === a.pid)) $.ui.toast(`App no ar: ${a.name} :${a.ports.join(', :')}`)
    }
    await update($, scan, () => ({ apps, checkedAt, error: null }))
  } catch (err) {
    const checkedAt = await $.clock.now()
    await update($, scan, s => ({ ...s, checkedAt, error: String(err).slice(0, 200) }))
  } finally {
    running = false
  }
}

async function kill($: EngineInterface, pid: number) {
  await update($, pendingKill, () => null)
  const platform = pickPlatform(await $.env.get('OS'))
  await $.process.run(platform.killArgv(pid), { timeoutMs: 10_000 })
  await update($, scan, s => ({ ...s, apps: s.apps.filter(a => a.pid !== pid) }))
  void refresh($)
}

/** Primeiro clique arma, segundo encerra. */
async function pressKill($: EngineInterface, pid: number) {
  if ((await read($, pendingKill)) === pid) await kill($, pid)
  else {
    await update($, pendingKill, () => pid)
    $.clock.after(5_000, () => void update($, pendingKill, cur => (cur === pid ? null : cur)))
  }
}

async function recordCall($: EngineInterface, start: number) {
  const end = await $.clock.now()
  await update($, calls, list => [...list, { start, end }].slice(-500))
}

const url = (port: number) => `http://localhost:${port}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'apps',
      description: 'Abre o painel dos servidores locais que o Claude subiu nesta sessão',
    })
    void refresh($)
    $.clock.every(15_000, () => void refresh($))
    return started
  })

  on('command.run', { command: 'apps' }, async $ => {
    void refresh($)
    await $.ui.open({ id: PANE, title: 'Apps rodando' })
    return { text: 'Painel "Apps rodando" aberto.' }
  })

  // Um comando acabou de rodar: o servidor pode levar alguns segundos para abrir a porta.
  // Só observa: se algo aqui falhar, a chamada da ferramenta segue normalmente.
  // A janela de tempo de cada comando é o que permite reconhecer depois um servidor desacoplado.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const start = await $.clock.now()
    const ran = await next(e)
    await recordCall($, start)
    $.clock.after(e.run_in_background ? 3_000 : 1_000, () => void refresh($))
    return ran
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const start = await $.clock.now()
    const ran = await next(e)
    await recordCall($, start)
    $.clock.after(3_000, () => void refresh($))
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { apps } = await read($, scan)
    if (e.props.hasSurvey || apps.length === 0) return next(e)
    const armed = await read($, pendingKill)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    // Colunas alinhadas: nome e PID com largura fixa pelo maior da lista.
    const nameW = Math.max(...apps.map(a => a.name.length))
    const pidW = Math.max(...apps.map(a => String(a.pid).length))

    // Uma linha por app; o Link sem label mostra a URL uma vez só (o terminal sem OSC 8
    // desenha "label URL", o que duplicava).
    return (
      <Box flexDirection="column">
        <Text color="success">▶ apps rodando ({apps.length})</Text>
        {apps.map(a => (
          <Box key={`app-${a.pid}`} flexDirection="row" gap={2}>
            <Button
              key={`kill-${a.pid}`}
              plain
              label={armed === a.pid ? 'encerrar?' : '✕'}
              onPress={() => pressKill($, a.pid)}
            />
            <Text dimColor={a.orphan}>{a.name.padEnd(nameW)}</Text>
            <Text dimColor>PID {String(a.pid).padEnd(pidW)}</Text>
            {a.ports.map(p => <Link href={url(p)} />)}
            {a.orphan && <Text color="warning">órfão</Text>}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { apps, checkedAt, error } = await read($, scan)
    const armed = await read($, pendingKill)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const width = Math.max(20, (e.props.bodyColumns ?? 60) - 2)
    const when = checkedAt ? new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'

    return (
      <Box flexDirection="column" gap={1}>
        {apps.length === 0 && <Text dimColor>Nenhum servidor iniciado pelo Claude nesta sessão.</Text>}
        {apps.map(a => (
          <Box key={`row-${a.pid}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text bold>{a.name}</Text>
              <Text dimColor>PID {a.pid}</Text>
              {a.orphan && <Text color="warning">órfão</Text>}
            </Box>
            <Box flexDirection="row" gap={2}>
              {a.ports.map(p => <Link href={url(p)} label={url(p)} />)}
            </Box>
            <Text dimColor wrap="truncate-end">{a.commandLine.slice(0, width * 2)}</Text>
            <Button
              key={`pkill-${a.pid}`}
              label={armed === a.pid ? 'confirmar encerramento' : 'encerrar'}
              onPress={() => pressKill($, a.pid)}
            />
          </Box>
        ))}
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" label="atualizar" onPress={() => refresh($)} />
          <Text dimColor>{error ? `⚠ ${error}` : `verificado ${when}`}</Text>
        </Box>
      </Box>
    )
  })
}
