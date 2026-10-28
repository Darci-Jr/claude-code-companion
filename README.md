# Claude Code Companion

Ferramentas visuais para o [Claude Code](https://claude.com/claude-code), em duas partes independentes:

| Parte | O que é | Onde roda |
| --- | --- | --- |
| [`extension/`](extension/) | Extensão do VS Code: indicadores de uso na status bar, painel lateral com contexto da sessão, botões de ação e flash na taskbar do Windows | VS Code (Windows) |
| [`mods/`](mods/) | Mods do Claude Code, cada um instalável separadamente | Dentro do próprio Claude Code |

## Mods

Cada mod é um plugin independente: instale só os que quiser.

| Mod | O que faz |
| --- | --- |
| [`apps-rodando`](mods/apps-rodando/) | Faixa acima do prompt e comando `/apps` com os servidores locais que o Claude subiu na sessão: portas, link e botão para encerrar |

Para instalar, no prompt de uma sessão do Claude Code no terminal:

```
/plugin install apps-rodando --marketplace Darci-Jr/claude-code-companion
```

Responda `y` para adicionar o marketplace e escolha o escopo (o de usuário vem primeiro). De um shell:

```
claude plugin install apps-rodando --marketplace Darci-Jr/claude-code-companion
```

No app desktop, onde `/plugin` não roda: clique em **+** ao lado da caixa do prompt → **Plugins** → **Add marketplace** com `Darci-Jr/claude-code-companion` → **Add plugin**.

## Extensão do VS Code

Veja [`extension/README.md`](extension/README.md) para compilar e instalar.

## Licença

[MIT](LICENSE)
