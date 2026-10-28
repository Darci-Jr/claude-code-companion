# Mods

Cada pasta aqui é um mod independente do Claude Code (um plugin com um módulo de hooks), instalado sozinho pelo nome:

```
/plugin install <mod> --marketplace Darci-Jr/claude-code-companion
```

## Adicionando um mod novo

1. Crie `mods/<nome-do-mod>/` com:
   - `.claude-plugin/plugin.json` — `name` igual ao nome da pasta, `version`, `description`
   - `hooks/hooks.json` — `{ "modules": ["./register.tsx"] }`
   - `hooks/register.tsx` — o módulo (`export const register: Register = (on) => { ... }`)
   - `types/index.d.ts` — o contrato de `$.state`, se o mod guarda estado
   - `tests/*.test.tsx` — testes, rodados com `claude plugin test mods/<nome-do-mod>`
   - `README.md` — o que o mod faz e como usar
2. Adicione uma entrada em [`../.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json):
   ```json
   { "name": "<nome-do-mod>", "source": "./mods/<nome-do-mod>", "description": "..." }
   ```
3. Valide: `claude plugin validate mods/<nome-do-mod>`.
4. Liste o mod na tabela do [README da raiz](../README.md).

Para desenvolver um mod carregado direto da pasta: `claude --plugin-dir mods/<nome-do-mod>`.
