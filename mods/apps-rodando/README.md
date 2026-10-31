# apps-rodando

Mod do Claude Code que mostra os servidores locais que o Claude subiu **na sessão atual**.

```
▶ apps rodando (2)
✕  node  PID 12896  http://localhost:5182  http://localhost:5183
✕  node  PID 19348  http://localhost:5181
```

- **Faixa acima do prompt** — aparece só quando há algo rodando; uma linha por app, com as URLs.
- **`✕`** — encerra o processo e seus subprocessos em dois cliques (o primeiro vira `encerrar?`).
- **`/apps`** — abre um painel com PID, URLs, linha de comando, encerrar e atualizar.
- **Aviso** quando um servidor novo sobe.

## Como detecta

- Servidores filhos dos comandos Bash/PowerShell do Claude desta sessão (servidores MCP, o app desktop e outras sessões ficam de fora).
- Servidores desacoplados (`Start-Process`, `start`, `nohup … &`): o mod registra a janela de tempo de cada comando e atribui à sessão o processo sem pai que nasceu dentro dela.
- Um servidor que continua rodando depois que a sessão que o subiu encerrou aparece como `órfão`.

Atualiza alguns segundos depois de cada comando e a cada 15s.

## Requisitos

- **Windows** — usa `Get-CimInstance Win32_Process`, `Get-NetTCPConnection` e `taskkill`.
- **Linux** — usa `ps` e `ss`, já presentes na maioria das distribuições; encerra com `SIGTERM` e, depois de 1s, `SIGKILL`.

O código específico de cada sistema fica em [`hooks/platform.ts`](hooks/platform.ts).

## Instalação

```
/plugin install apps-rodando --marketplace Darci-Jr/claude-code-companion
```
