# Changelog

## M2 — identidade, escopo e credenciais

- Desenvolvimento em branch separada e revisão por pull request antes de integração na main.
- Provisionador local com senha oculta, Argon2id calibrado e vínculo de usuário sem redefinir senha.
- Sessões opacas por hash, cookies locais/HTTPS, rotação, expiração, logout e revogação pelo dono.
- Proteção de origem/CSRF e limites persistentes de login por conta/IP/global.
- Três papéis, consultas com escopo e alteração de membros com efeito nas sessões existentes.
- Emissão única e revogação de chaves restritas a projeto/ambiente, separadas das sessões.
- Auditoria transacional sanitizada e proteção concorrente do último administrador.
- 20 cenários PostgreSQL de identidade na CI, relatório e documentação de endpoints.

Ingestão/SDK/detecção e UI de login permanecem nas próximas entregas.

## M1 — 2026-10-08

Primeira base executável do Sentinel, sem release do MVP ainda.

- Monorepo pnpm, API Fastify, frontend Next.js e worker privado Python.
- Docker Compose com credenciais locais geradas, papéis de banco separados e health checks.
- Contrato v1 Zod/JSON Schema, allowlists e fixtures compartilhadas entre linguagens.
- Migrations Drizzle para organizações, usuários, vínculos, projetos, chaves, eventos e jobs.
- Checks, testes de integridade PostgreSQL e CI com actions fixadas por commit.
- README de execução, documentação técnica e relatório de validação.

Autenticação, ingestão, SDK e detecção serão entregues em M2–M4.

## M0 — 2026-10-08

- Contexto e escopo recuperados da conversa de origem.
- Arquitetura, modelo de ameaças, critérios de validação e roadmap.
- Planejamento publicado em três commits separados.
