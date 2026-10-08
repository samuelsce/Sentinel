# Roadmap e plano de commits

Planejamento inicial em 8 de outubro de 2026. A ordem prioriza uma integração funcional do SDK ao alerta antes de ampliar a interface. Cada marco terá uma entrega demonstrável; cronograma em dias será estimado após o bootstrap e a primeira medição do ambiente.

## M0 — contexto e planejamento

Concluída: escopo, stack, arquitetura, ameaças, validação e este roadmap. Planejamento publicado em três commits.

Commits da etapa:

1. `docs: define Sentinel product scope and architecture`
2. `docs(security): define threat model and validation criteria`
3. `docs: add implementation roadmap and design guidance`

## M1 — ambiente e contratos

Implementada. Estado de validação e evidências em [milestones/M1.md](milestones/M1.md). Instruções verificadas no README e em [DEVELOPMENT.md](DEVELOPMENT.md).

Dependência: M0.

- Criar workspaces TypeScript e projeto Python com versões compatíveis fixadas.
- Subir PostgreSQL, API, worker e frontend mínimo com Docker Compose.
- Definir configurações por ambiente, `.env.example`, health checks e logging sanitizado.
- Implementar contrato v1, fixtures e fluxo de migrations pelo Drizzle.
- Criar CI básica com lint, typecheck, testes e verificação de contratos.

Commits sugeridos:

1. `chore: bootstrap monorepo and development environment`
2. `feat(contracts): define versioned security event schema`
3. `feat(database): add tenant and event migrations`
4. `ci: validate TypeScript Python and event contracts`

Aceite: clone limpo inicia o ambiente conforme README; migrations funcionam do zero e fixtures concordam entre linguagens. Fixar versões do Node.js, Next.js, Fastify, Zod, Python e PostgreSQL aqui; documentar compatibilidade, sem escolher versões por memória.

## M2 — identidade, escopo e credenciais

Implementada em branch separada; segue por PR com checks, sem merge automático. Evidências e limites em [milestones/M2.md](milestones/M2.md); comandos e endpoints em [AUTHENTICATION.md](AUTHENTICATION.md).

Dependência: M1.

- Provisionar primeiro administrador por comando local seguro.
- Implementar login/logout, sessões e proteção CSRF.
- Criar organizações/projetos/vínculos e autorização por papel.
- Implementar geração, hash e revogação de chaves de ingestão.
- Auditar mudanças sensíveis e criar fixtures de duas organizações.

Commits sugeridos:

1. `feat(auth): add revocable sessions and role authorization`
2. `feat(projects): add scoped projects and ingestion credentials`

Aceite: V05, V06 e V09 na superfície disponível; IDs conhecidos de outra organização não permitem acesso. Chaves não concedem acesso ao dashboard.

## M3 — ingestão e SDK

Implementada na branch `feat/m3-ingestion-sdk`, com PR e checks. Evidências e limites em [milestones/M3.md](milestones/M3.md); execução e protocolo em [INGESTION.md](INGESTION.md).

Dependência: M2.

- Implementar endpoint de lote, validação, quotas e deduplicação.
- Persistir eventos e jobs na mesma transação.
- Implementar SDK de servidor com timeout, buffer limitado e retries controlados.
- Preparar aplicação de exemplo com instrumentação de login e autorização.

Commits sugeridos:

1. `feat(ingest): persist validated events and durable detection jobs`
2. `feat(sdk): add server event client with bounded retries`
3. `feat(demo): instrument sample application security events`

Aceite: reenvio não altera contagem; chave inválida/revogada e payload inválido falham; API indisponível não derruba a demo. Limites e perdas no buffer do SDK são observáveis.

## M4 — primeira fatia completa e três detecções

Implementada na branch `codex/m4-detection-and-investigation`, com entrega por PR e checks. [Guia de investigação](DETECTIONS.md) e [evidências/limites](milestones/M4.md). Dependência: M3.

- Criar claim/lease/retry dos jobs e recuperar interrupções.
- Implementar `AUTH-001` primeiro e confirmar ingestão → alerta por API.
- Adicionar `AUTHZ-001` e `ADMIN-001`, com episódios, versões e evidências.
- Implementar consultas de eventos/alertas e auditoria de investigação.
- Criar cenários positivos/benignos e testar tempo, duplicados e escopo.

Commits sugeridos:

1. `feat(detector): add durable worker and login failure detection`
2. `feat(detector): add access denial and admin activity rules`
3. `feat(alerts): add evidence queries and investigation workflow`

Aceite: V02, V03, V04 e V08; cada alerta explica a regra aplicada. Antes do dashboard completo, a integração já deve funcionar em testes de ponta a ponta pela API.

## M5 — interface e investigação

Dependência: M4. Pesquisa visual pode começar após M1; implementação dos fluxos usa contratos reais.

- Aplicar a skill de referências indicada em AGENTS.md e sua skill complementar.
- Registrar exemplos consultados e decisões específicas em `docs/DESIGN.md` nesta etapa.
- Construir acesso, projetos/integração, visão geral, eventos, alertas e detalhe da investigação.
- Implementar filtros, paginação, papéis, estados vazio/erro e timeline de evidências.
- Conectar SSE e recuperação por consulta; checar keyboard, foco e mobile.

Commits sugeridos:

1. `docs(design): record dashboard references and interaction decisions`
2. `feat(web): add project onboarding and event investigation`
3. `feat(web): add live overview and alert workflow`

Aceite: V01 e V07 com dados reais da demo; cenários podem ser entendidos pela interface. Referências efetivamente utilizadas são citadas; não apresentar um layout escolhido antes da pesquisa.

## M6 — validação, operação e v0.1.0

Dependência: M5.

- Completar casos de abuso e segurança, CI com Semgrep/análise de dependências e correções encontradas.
- Implementar retenção, snapshots mínimos de evidência e métricas de ingestão/fila.
- Medir as metas de laboratório, investigar falhas e registrar limitações.
- Produzir walkthrough, screenshots e relatório dos três cenários.
- Atualizar README com setup verificado e comandos reais.

Commits sugeridos:

1. `feat(ops): add retention and pipeline health metrics`
2. `test(security): verify isolation recovery and abuse limits`
3. `ci(security): add static and dependency analysis`
4. `docs: publish reproducible Sentinel demo and validation results`

Aceite: V01–V12 e nenhuma falha crítica conhecida sem resolução. Tag `v0.1.0` somente após os critérios, não na etapa de planejamento. Demo local reproduzível é suficiente para este marco.

## M7 — resposta e v0.2.0

Dependência: M6.

- Implementar protocolo de ações autorizado e adaptador na demo.
- Solicitar bloqueio manual com motivo e TTL; confirmar aplicação, falha e expiração.
- Permitir configuração administrativa das regras, com versão e auditoria.
- Exportar relatório sanitizado de investigação.

Commits sugeridos:

1. `feat(response): add audited temporary IP blocking adapter`
2. `feat(rules): add versioned project rule configuration`
3. `feat(reports): export sanitized investigation evidence`

Aceite: bloqueio impede acesso apenas na aplicação/projeto esperado, expira corretamente e registra resultado. Alterar configuração não reinterpreta silenciosamente evidências anteriores.

## M8 — publicação e evolução

Dependência: M6 para demo de leitura; M7 para demonstrar resposta controlada.

- Escolher provedor, orçamento, domínio e limites de uso.
- Configurar secrets/TLS/rede privada, health checks e backups; testar restauração.
- Separar demo pública fictícia de qualquer projeto real e retirar os simuladores da superfície pública.
- Planejar convites, recuperação de acesso, MFA e integrações a partir dos resultados.
- Adotar Redis/FastAPI ou paralelismo do worker somente com justificativa medida.

Commits e data de deploy serão definidos com o destino escolhido. `v1.0.0` depende de operação e escopo definidos; não é uma promessa de calendário ou maturidade empresarial.

## Regra para versionamento

Cada commit deve representar uma mudança coerente e explicar comportamento e validação. Testes necessários acompanham a funcionalidade; os commits de teste acima complementam a validação transversal, não adiam a cobertura básica.

Antes de cada push: revisar diff e segredos, executar os checks aplicáveis, atualizar documentos afetados e conferir status. Não acumular a aplicação inteira em um único commit. Alterações de arquitetura relevantes recebem registro de decisão quando surgirem.

## Decisões ainda abertas

| Decisão | Quando resolver | Base para escolha |
| --- | --- | --- |
| Versões e adaptadores de schema | M1 | Documentação, suporte e teste de compatibilidade |
| Bibliotecas de auth/hash e limites | Resolvida na M2 | Argon2id, cookie Fastify, sessões opacas e contadores PostgreSQL; ver AUTHENTICATION.md |
| Parâmetros finais das três regras | M4/M6 | Cenários, falsos positivos e métricas |
| Direção visual | M5 | Skill, referências verificadas e conteúdo real |
| Provedor e orçamento | M8 | Custo, execução do worker, SSE e backup |
| Redis, FastAPI e workers paralelos | Após medir | Backlog, contenção, limites distribuídos e necessidade de API |

Próxima entrega: M5, com dashboard e investigação visual usando as consultas reais da M4. A fila, as três regras e as evidências já estão implementadas.
