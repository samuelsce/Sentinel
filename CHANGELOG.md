# Changelog

## M7 — resposta controlada e candidata v0.2.0

- Bloqueio manual auditado com IP de evidência, motivo, TTL e resultados confirmados.
- Credencial de resposta independente e revogável; adaptador na demo HTTP com restauração, expiração offline e sobreposição.
- Regras por projeto com edição administrativa, versões append-only e seleção congelada na entrada do evento.
- Relatório sanitizado com pseudônimos locais e projeção permitida a partir de snapshots.
- Fluxos acessíveis de resposta/regras/exportação, 18 cenários PostgreSQL e 11 jornadas Chromium na CI.
- Retenção protege ações ativas; readiness exige a migração nova; scan do bundle inclui chaves de resposta.

Versão candidata 0.2.0; tag após revisão/integração solicitada. Sem deploy público ou merge automático. [Reprodução e limites](docs/RESPONSE.md), [validação](docs/milestones/M7.md).

## M6 — operação e candidata v0.1.0

- Snapshots de evidência independentes, backfill e preservação de investigação após purge.
- Retenção privada por escopo, dry-run, lotes limitados e proteção de trabalho pendente.
- Métricas privadas de ingestão/fila, timestamps de conclusão e medição de espaço.
- Seleção de jobs com recibo/indexação próprios e pausa somente quando a fila está vazia.
- Oito cenários PostgreSQL operacionais/de abuso e nove fluxos reais Chromium.
- Semgrep/regressões, auditoria de dependências e inspeção do bundle público na CI.
- Correção de esbuild transitivo, walkthrough e medição documentada em M6.

Entrega por PR; tag v0.1.0 após revisão e integração, sem merge automático. Resposta manual/configuração de regras/exportação continuam na M7; deploy/backup na M8.

## M5 — dashboard e investigação ao vivo

- Login/logout, workspaces, criação de projetos e integração com chaves exibidas uma única vez.
- Overview real, filtros/paginação de eventos/alertas, detalhes e timeline de evidências.
- Triagem com papéis, CSRF, auditoria e conflito de versão explícito.
- Proxy restrito de mesma origem, SSE autenticado e recuperação por consultas.
- Seis cenários PostgreSQL de overview/SSE e oito fluxos Chromium, incluindo mobile e teclado.
- README com screenshots fictícios, guia do dashboard, referências e relatório da entrega.

Retenção, análise estática/dependências e métricas de carga permanecem na M6; resposta manual/configuração/relatórios na M7.

## M4 — detecção e investigação pela API

- Worker durável com claims, leases de 30 s, fencing, cinco tentativas e recuperação de interrupções.
- AUTH-001, AUTHZ-001 e ADMIN-001 versionadas, com episódios e evidências transacionais limitadas.
- Ordem de recebimento preservada por sequência em lotes com timestamp idêntico.
- Consultas paginadas com escopo e triagem com versão otimista, CSRF e auditoria.
- Demo ampliada para 22 eventos e E2E que confirma três alertas com papéis reais.
- 21 cenários PostgreSQL de recuperação/investigação na CI e documentação reproduzível.

Dashboard, SSE, retenção, métricas de carga e resposta continuam planejados.

## M3 — ingestão e SDK

- Ingestão com chave de máquina, quotas persistentes e evento/job na mesma transação.
- SDK Node.js com buffer, retries e contadores de perda; demo HTTP instrumentada.
- 13 cenários PostgreSQL incluindo deduplicação, quotas e resposta perdida após commit.

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
