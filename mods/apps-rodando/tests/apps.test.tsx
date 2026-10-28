import { expect, mock, test } from 'claude-code/testing'

// Árvore de processos simulada:
//   100 claude.exe (CLI desta sessão) ─┬─ 900 powershell (a consulta do próprio mod)
//                                      ├─ 200 bash (ferramenta) ── 300 node :5180   ← conta
//                                      └─ 400 cmd /c npx mcp ───── 401 node :9999   ← MCP, não conta
//   500 claude.exe (app desktop) ──────── 501 bash ─────────────── 502 node :7000   ← outra árvore
const FIXTURE = {
  self: 900,
  procs: [
    { ProcessId: 100, ParentProcessId: 1, Name: 'claude.exe', CommandLine: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', Created: '2026-10-27T10:00:00' },
    { ProcessId: 900, ParentProcessId: 100, Name: 'powershell.exe', CommandLine: 'powershell.exe -NoProfile -Command ...', Created: '2026-10-27T10:05:00' },
    { ProcessId: 200, ParentProcessId: 100, Name: 'bash.exe', CommandLine: 'bash.exe -c "source shell-snapshots/x.sh && node server.js"', Created: '2026-10-27T10:01:00' },
    { ProcessId: 300, ParentProcessId: 200, Name: 'node.exe', CommandLine: 'node server.js', Created: '2026-10-27T10:01:01' },
    { ProcessId: 400, ParentProcessId: 100, Name: 'cmd.exe', CommandLine: 'cmd.exe /d /s /c "npx @playwright/mcp@latest"', Created: '2026-10-27T10:00:01' },
    { ProcessId: 401, ParentProcessId: 400, Name: 'node.exe', CommandLine: 'node mcp.js', Created: '2026-10-27T10:00:02' },
    { ProcessId: 500, ParentProcessId: 1, Name: 'claude.exe', CommandLine: 'C:\\AnthropicClaude\\app\\claude.exe', Created: '2026-10-27T09:00:00' },
    { ProcessId: 501, ParentProcessId: 500, Name: 'bash.exe', CommandLine: 'bash.exe', Created: '2026-10-27T09:00:01' },
    { ProcessId: 502, ParentProcessId: 501, Name: 'node.exe', CommandLine: 'node other.js', Created: '2026-10-27T09:00:02' },
  ],
  listen: [
    { LocalPort: 5180, OwningProcess: 300 },
    { LocalPort: 9999, OwningProcess: 401 },
    { LocalPort: 7000, OwningProcess: 502 },
  ],
}

const BAND = {
  plugin: 'apps-rodando',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('a faixa mostra só o servidor que o Claude desta sessão subiu, e encerra em dois cliques', async ($, on) => {
  const clock = mock.clock(on)
  const killed: string[] = []
  // O que o engine desenha na faixa quando o mod passa a vez.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'apps' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'taskkill') {
      killed.push(e.argv[2]!)
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    const listen = killed.includes('300') ? FIXTURE.listen.filter(l => l.OwningProcess !== 300) : FIXTURE.listen
    return { value: { exitCode: 0, stdout: JSON.stringify({ ...FIXTURE, listen }), stderr: '' } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^node/ }))?.text).toBe('node')
  expect(await ui.find({ type: 'Link', text: 'http://localhost:5180' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'http://localhost:9999' })).toBeUndefined()
  expect(await ui.find({ type: 'Link', text: 'http://localhost:7000' })).toBeUndefined()

  await ui.press({ key: 'kill-300' })
  expect(killed).toEqual([])
  await ui.press({ key: 'kill-300' })
  expect(killed).toEqual(['300'])

  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^node/ })).toBeUndefined()
  await ui.unmount()
})

test('a faixa vazia aparece quando o Claude sobe um servidor depois', async ($, on) => {
  const clock = mock.clock(on)
  let up = false
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'apps' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => {
    up = true
    return { result: {} }
  })
  on('process.run', () => {
    const listen = up ? FIXTURE.listen : FIXTURE.listen.filter(l => l.OwningProcess !== 300)
    return { value: { exitCode: 0, stdout: JSON.stringify({ ...FIXTURE, listen }), stderr: '' } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^node/ })).toBeUndefined()

  await $.tool.call({ tool: 'Bash', command: 'node server.js', run_in_background: true })
  await clock.advance(3_000)
  expect((await ui.find({ type: 'Text', text: /^node/ }))?.text).toBe('node')
  await ui.unmount()
})

test('servidor desacoplado (Start-Process) conta só se nasceu durante um comando da sessão', async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(Date.parse('2026-10-27T10:10:00.000Z'))
  let started = false
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'apps' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => {
    started = true
    return { result: {} }
  })
  on('process.run', () => {
    const procs = [
      ...FIXTURE.procs,
      // pai 599 já morreu; nasceu 1s depois do início do comando → é desta sessão
      { ProcessId: 600, ParentProcessId: 599, Name: 'node.exe', CommandLine: 'node detached.js', Created: '2026-10-27T10:10:01.1234567Z' },
      // também sem pai, mas nasceu uma hora antes → não é
      { ProcessId: 700, ParentProcessId: 699, Name: 'node.exe', CommandLine: 'node antigo.js', Created: '2026-10-27T09:10:00.0000000Z' },
    ]
    const listen = [
      ...FIXTURE.listen,
      ...(started ? [{ LocalPort: 5184, OwningProcess: 600 }] : []),
      { LocalPort: 8080, OwningProcess: 700 },
    ]
    return { value: { exitCode: 0, stdout: JSON.stringify({ ...FIXTURE, procs, listen }), stderr: '' } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'PowerShell', command: 'Start-Process node detached.js' })
  await clock.advance(3_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Link', text: 'http://localhost:5184' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'http://localhost:5180' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'http://localhost:8080' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'órfão' })).toBeUndefined()
  await ui.unmount()
})
