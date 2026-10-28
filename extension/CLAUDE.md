# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O projeto

Extensão do VS Code ("Claude Code Companion") que funciona como camada visual sobre o terminal do Claude Code: indicadores de uso na status bar, painel lateral (webview) com detalhes e botões de ação, e "flash" na taskbar do Windows quando o Claude termina ou pede confirmação. Não há testes nem linter — a validação é manual (F5 / instalar o vsix).

## Comandos

```powershell
npm run compile     # tsc -p ./  (saída em out/)
npm run watch       # tsc em watch mode
npx --yes @vscode/vsce package --allow-missing-repository --skip-license   # gera o .vsix
code --install-extension .\claude-code-companion-<versão>.vsix --force     # instala para teste
```

Para testar em dev: abrir a pasta no VS Code e pressionar F5 (Extension Development Host). Ao lançar nova versão, atualizar `version` no package.json antes de empacotar.

## Arquitetura

**Decisão central:** o VS Code não permite sobrepor UI ao terminal integrado, então a "camada" vive em status bar + sidebar (escolha deliberada em vez de terminal embutido com xterm.js/node-pty). O terminal do Claude é um terminal nativo criado pela extensão e controlado via `sendText`.

### Serviços de dados (src/)

Quatro serviços independentes com o mesmo padrão `start()` / `onChange(fn)` / `getSnapshot()`, agregados em `extension.ts`:

- **`status.ts` (StatusService)** — limites oficiais do plano (5h / 7 dias / créditos extras), consultando `https://api.anthropic.com/api/oauth/usage` com o token OAuth de `~/.claude/.credentials.json` (header `anthropic-beta: oauth-2025-04-20`). Poll a cada 2 min.
- **`usage.ts` (UsageService)** — consumo local agregado: varre todos os `.jsonl` de `~/.claude/projects/`, com leitura incremental por offset de bytes (só processa linhas completas). Calcula janela de 5h ativa (detectada por gap > 5h entre turnos) e total semanal. Contém a tabela `PRICING` (USD/MTok) e `costOf()` — cache write 1,25× (5min) / 2× (1h), cache read 0,1× do input. **A tabela de preços é manual; conferir com a tabela pública da Anthropic ao adicionar modelos.**
- **`session.ts` (SessionService)** — sessão ativa do workspace atual. O diretório do projeto é `~/.claude/projects/<cwd com [^a-zA-Z0-9] → '-'>`; a sessão ativa é o `.jsonl` modificado mais recentemente. "Contexto atual" = `input + cache_read + cache_creation` do **último** `usage` de mensagem assistant — ignorando mensagens sintéticas (`model: "<synthetic>"`, geradas localmente) e sidechains (`isSidechain: true`, subagents com contexto próprio; contam só no custo). Janela de contexto, em ordem: override da config `contextWindow` (> 0) → contexto observado > 200k ⇒ 1M (evidência direta) → Haiku ⇒ 200k (salvo se o `model` de `~/.claude/settings.json` for Haiku com sufixo `[1m]`) → demais modelos ⇒ 1M (o transcript registra só o ID puro do modelo, sem `[1m]`).

- **`apps.ts` (AppsService)** — servidores locais que o Claude subiu. Poll a cada 15s via PowerShell (`Win32_Process` + `Get-NetTCPConnection -State Listen`): lista processos com porta em LISTEN cuja cadeia de ancestrais passa por um shell de ferramenta (`bash`/`sh`/`powershell`/`pwsh`, ou `cmd` envolvendo powershell) filho direto do CLI `claude`. Exclui o app desktop (`AnthropicClaude\…\claude.exe`, também chamado claude.exe) e MCPs (`cmd /c npx …`). PIDs já vistos (com mesma `CreationDate`) continuam listados como "órfãos" depois que o Claude encerra. "Encerrar" = `taskkill /T /F`.

### Apresentação

- **`extension.ts`** — ativação, quatro itens de status bar (janela 5h, semana 7d, contexto da sessão e relógio do cache de prompt — este re-renderizado a cada 30s por timer, já que o tempo passa sem novos dados; cores `warningBackground`/`errorBackground` por threshold), registro de comandos, e a feature Flash: um named pipe (`\\.\pipe\claude-code-flash`) recebe 1 byte dos hooks do Claude Code (Stop/Notification, instalados em `~/.claude/settings.json` pelo comando `installHooks`) e dispara `FlashWindowEx` via PowerShell. O sinal do pipe também força refresh de status/sessão.
- **`panel.ts` + `media/panel.html`** — webview da sidebar. O HTML é carregado de `media/panel.html` substituindo os placeholders `__NONCE__`/`__CSP_SOURCE__`. Protocolo postMessage: extensão → webview (`usage`, `status`, `session`, `apps`, `terminal-state`); webview → extensão (`ready`, `refresh-status`, `refresh-apps`, `app-open` {port}, `app-kill` {pid}, `open-terminal`, `focus-terminal`, `restart-terminal`, `cmd-new`, `cmd-resume`, `cmd-rename`, `cmd-clear`). Ao mexer no protocolo, atualizar os dois lados.

### Injeção de comandos no terminal

Slash commands (`/clear`, `/rename …`) são enviados ao TUI do Claude em duas etapas: `sendText(texto, false)`, espera ~300ms, depois `sendText('\r', false)` — um newline embutido é menos confiável com o TUI. Se o terminal acabou de ser criado, espera ~6s para o `claude` subir antes de injetar. "Nova sessão" e "Resume" reiniciam o terminal (`claude` / `claude --resume`) em vez de injetar comando.

## Específico de Windows

O projeto assume Windows: shell padrão `powershell.exe`, flash via Win32 `FlashWindowEx` (subindo a árvore de processos até a janela raiz do VS Code via WMI), e hooks gravados como script `.ps1` em `~/.claude/` para evitar problemas de escape.
