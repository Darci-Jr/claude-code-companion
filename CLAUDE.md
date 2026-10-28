# CLAUDE.md

Repositório com duas partes independentes:

- **`extension/`** — extensão do VS Code (Claude Code Companion). Arquitetura, comandos de build e convenções em [`extension/CLAUDE.md`](extension/CLAUDE.md); os comandos `npm` rodam dentro de `extension/`.
- **`mods/`** — mods do Claude Code, um por pasta, cada um instalável sozinho pelo marketplace em `.claude-plugin/marketplace.json`. Como adicionar um mod: [`mods/README.md`](mods/README.md). Validar com `claude plugin validate mods/<mod>` e testar com `claude plugin test mods/<mod>`.

Repositório público: nada de dados pessoais, caminhos da máquina ou tokens nos arquivos. Commits usam o e-mail configurado localmente neste repo.
