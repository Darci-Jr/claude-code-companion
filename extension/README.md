# Claude Code Companion (extensão VS Code)

Camada visual sobre o terminal do Claude Code no VS Code, para Windows e Linux:

- **Status bar** — uso da janela de 5h e da semana (limites oficiais do plano), contexto da sessão atual e relógio do cache de prompt.
- **Painel lateral** — detalhes de uso, contexto, servidores locais que o Claude subiu (com abrir/encerrar) e botões: nova sessão, resume, rename, clear.
- **Aviso de atenção** — quando o Claude termina ou pede confirmação (hooks `Stop`/`Notification`), a janela do VS Code pisca na taskbar no Windows; no Linux aparece uma notificação do sistema (`notify-send`) se a janela estiver sem foco.

## Compilar e instalar

No Linux os comandos são os mesmos, com `./` em vez de `.\`. A lista de servidores usa `ps` e `ss`.

```powershell
cd extension
npm install
npm run compile
npx --yes @vscode/vsce package --allow-missing-repository --skip-license --baseContentUrl https://github.com/Darci-Jr/claude-code-companion/blob/main/extension
code --install-extension .\claude-code-companion-<versão>.vsix --force
```

Para desenvolver: abra a pasta `extension/` no VS Code e pressione **F5**.

Depois de instalar, rode `Ctrl+Shift+P` → **Claude Code Flash: Instalar hooks do Claude Code** para ativar o aviso (grava em `~/.claude/settings.json`; reinicie as sessões do Claude Code).

## Configurações

- `claudeCodeCompanion.claudeCommand` — comando que inicia o Claude Code (padrão `claude`).
- `claudeCodeCompanion.shell` — shell do terminal (vazio = `powershell.exe` no Windows, `$SHELL` no Linux).
- `claudeCodeCompanion.contextWindow` — janela de contexto em tokens; `0` detecta automaticamente.
- `claudeCodeCompanion.cacheTtlMinutes` — TTL do cache de prompt (padrão 60).
- `claudeCodeFlash.flashCount` — piscadas (`0` = até a janela receber foco).
- `claudeCodeFlash.pipeName` — nome do named pipe usado pelos hooks (no Linux, do arquivo de sinal em `~/.claude/`).

## Como funciona

Os limites do plano vêm do endpoint de uso da conta, com o token OAuth que o próprio Claude Code guarda em `~/.claude/.credentials.json` (lido localmente, nunca enviado a outro lugar). O consumo e o contexto são lidos dos transcripts em `~/.claude/projects/`. Detalhes de arquitetura em [`CLAUDE.md`](CLAUDE.md).
