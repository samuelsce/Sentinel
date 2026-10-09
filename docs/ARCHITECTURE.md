# Arquitetura do Sentinel

## Organização do código

```text
apps/
  web/                 Next.js: dashboard
  api/                 Fastify: REST, sessões e SSE
  demo/                aplicação própria instrumentada
services/
  detector/            Python: worker, regras e testes
packages/
  contracts/           Zod, JSON Schema e fixtures de eventos
  database/            Drizzle, migrations e consultas compartilhadas Node.js
  sdk/                 SDK TypeScript para servidores
infra/                 Docker Compose e configuração de execução
docs/                  produto, decisões, segurança e evidências
```

Monorepo com pnpm workspaces para TypeScript e um projeto Python independente, com dependências e lock próprios. M1 criou ambiente/contratos; M2 identidade; M3 ingestão, SDK e demo; M4 detecção/investigação; M5 dashboard, proxy e SSE; M6 snapshots, retenção e métricas; M7 resposta temporária, configuração por projeto e exportação. Veja [DEVELOPMENT.md](DEVELOPMENT.md), [AUTHENTICATION.md](AUTHENTICATION.md), [INGESTION.md](INGESTION.md), [DETECTIONS.md](DETECTIONS.md), [DASHBOARD.md](DASHBOARD.md) e [RESPONSE.md](RESPONSE.md). Publicação permanece na M8.

## Responsabilidades

- **Next.js:** páginas e interação; TanStack Query consulta a API. Componentes de servidor não devem compartilhar cache de respostas autenticadas entre organizações.
- **Fastify:** única API pública de negócio; autenticação, autorização, validação, ingestão, consultas, auditoria e SSE. Schemas de resposta evitam expor campos internos.
- **PostgreSQL:** fonte de verdade para eventos e resultados; fila persistente na mesma base no MVP.
- **Python:** processo privado para detecção, sem porta pública. Usa psycopg e os contratos JSON Schema publicados pelo pacote de contratos.
- **SDK:** emite eventos no servidor, com buffer limitado, timeout e retry. Nunca embutir a chave de ingestão em bundle do navegador. A garantia durável começa após o aceite da API: crash do app ou buffer cheio pode perder eventos antes disso; contabilizar descarte e oferecer flush no encerramento. Spool durável local será uma evolução caso necessária.
- **Demo:** aplicação separada, com credenciais fictícias e sessões próprias em memória na M3, sem acesso direto ao banco. Cenários de laboratório executados por comando local, sem endpoint público de simulação.

Drizzle será responsável pelas migrations. Python consome o schema, sem manter um segundo conjunto de migrations. Mudanças no contrato exigem fixtures de compatibilidade entre Node.js e Python.

## Ingestão e processamento

1. A aplicação envia lote com chave restrita ao projeto, por HTTPS.
2. A API identifica organização/projeto pela chave; valida tamanho, contrato e quota.
3. Uma transação grava eventos novos e seus jobs. `(project_id, event_id)` é único.
4. A API responde `202` após o commit, com IDs aceitos e duplicados; banco indisponível resulta em erro recuperável, sem confirmação falsa.
5. O worker reivindica jobs com `FOR UPDATE SKIP LOCKED`, grava lease e libera a transação antes do trabalho.
6. O worker aplica regras e persiste resultados, evidências e conclusão do job em transação. Escritas condicionadas ao lease evitam conclusão por worker obsoleto.
7. Jobs com lease expirado são recuperados; falhas recebem retry limitado com backoff e acabam em estado de falha inspecionável.
8. A API notifica alterações por SSE; a interface atualiza consultas e oferece polling como recuperação.

Processamento será **pelo menos uma vez**: alertas, evidências e conclusões precisam ser idempotentes. O MVP terá um worker ativo; múltiplos workers dependem de teste adicional de concorrência e serialização por chave de correlação.

`SKIP LOCKED` é usado somente na fila, não para consultas da investigação, devido à visão incompleta que pode produzir. A documentação do [PostgreSQL](https://www.postgresql.org/docs/current/sql-select.html) descreve seu uso para reduzir contenção em tabelas semelhantes a filas.

O uso da fila PostgreSQL é uma decisão de escopo para evitar um broker adicional inicialmente. Backlog, latência e contenção serão medidos; Redis não é dependência obrigatória do MVP. A M2 persiste contadores de login; a M3 persiste quotas por projeto e limita backlog. Concorrência de verificação de senha/ingestão é limitada por processo; escalar réplicas exige avaliar a capacidade total antes do deploy.

## Contrato de evento v1

A implementação estrutural da M1, suas variantes e limites estão em [CONTRACTS.md](CONTRACTS.md). Chaves, quotas e persistência estão implementadas na [M3](INGESTION.md).

| Campo | Regra |
| --- | --- |
| `schema_version` | Valor `1`; mudanças incompatíveis terão nova versão |
| `event_id` | UUID gerado pelo SDK, preservado nos retries |
| `type` | Enum de tipos aceitos |
| `occurred_at` | Data UTC da ocorrência |
| `environment` | Ambiente permitido pela chave, como `demo` ou `production` |
| `actor_id` | Identificador pseudônimo opcional; sem email/senha |
| `actor_role` | Papel na aplicação monitorada; não concede permissões no Sentinel |
| `source_ip` | IP do usuário observado pelo servidor monitorado; opcional e validado |
| `request_id` | Identificador de correlação opcional |
| `resource` | Identificador ou rota normalizada, sem query string sensível |
| `action`, `outcome` | Valores compatíveis com o tipo do evento |
| `metadata` | Campos permitidos por tipo, com limite de tamanho; sem conteúdo arbitrário |

Tipos iniciais: `auth.login_failed`, `auth.login_succeeded`, `authz.access_denied`, `admin.action`, `admin.privilege_changed`.

O servidor acrescenta `organization_id`, `project_id`, `received_at` e `ingestion_key_id`. `source_ip` permanece um dado validado do servidor monitorado; IP da conexão SDK não é persistido na M3. Campos de escopo enviados no payload não podem substituir o escopo da chave.

Limites implementados: até 100 eventos por lote, 256 KiB por requisição, 8 KiB por evento normalizado e rejeição integral do lote inválido. Duplicados idênticos retornam sucesso sem novo job; ID com conteúdo diferente retorna conflito. Quotas/backlog e política de replay em [INGESTION.md](INGESTION.md); metas de carga ainda serão medidas.

Para regras em tempo quase real, aceitar eventos com até 24 horas de atraso e 2 minutos no futuro; outros retornam erro explícito. Persistir ambos os timestamps. Correlação do MVP usa `received_at` e informa isso nas evidências; evita que timestamps controlados pelo emissor alterem janelas. Importação histórica e correlação por tempo de ocorrência serão evoluções separadas.

## Modelo de dados

| Entidade | Campos/relações centrais |
| --- | --- |
| `users`, `sessions` | Identidade, hash de senha; token de sessão armazenado como hash, expiração/revogação |
| `organizations`, `memberships` | Organização e vínculo de usuário com papel |
| `projects`, `ingestion_keys` | Escopo de aplicação/ambiente, prefixo e hash da chave, revogação |
| `events` | Contrato normalizado, timestamps, escopo e conteúdo validado |
| `detection_jobs` | Evento, estado, tentativas, lease, próxima execução e erro sanitizado |
| `rule_definitions` | Código/versão e parâmetros imutáveis; configuração por projeto futura |
| `detection_episodes`, `alerts`, `alert_evidence` | Correlação persistida, decisões, janela, estado e evidências |
| `audit_entries` | Ator, ação, recurso, instante e campos alterados sanitizados |
| `response_actions` (P1) | Pedido de bloqueio, alvo, TTL, estado e resultado do adaptador |

Eventos, jobs, regras e alertas carregam escopo. Usar chaves compostas/restrições que impeçam associar projeto ou evidência de outra organização. Toda consulta da API recebe escopo derivado da sessão. Índices iniciais: projeto/recebimento, projeto/tipo/recebimento, jobs prontos e alertas por projeto/estado/data.

Paginação de eventos usa cursor `(received_at, ingest_order)`, com limites de página e precisão preservada do banco. Alertas/jobs usam `(created_at, id)`. As listas não são snapshots. Evitar carregar todos os registros para gerar gráficos. Particionamento e agregações materializadas só após medir o volume.

## Regras do MVP

Parâmetros abaixo são valores iniciais do laboratório, não indicadores universais de ataque. Persistir versão, limiar, contagem, janela e eventos que explicam a decisão.

| Regra | Correlação e gatilho | Severidade inicial |
| --- | --- | --- |
| `AUTH-001` | ≥ 5 falhas de login em 5 min, por projeto/ambiente/IP; usar ator quando IP ausente; sem identificador confiável não correlacionar | Alta |
| `AUTHZ-001` | ≥ 10 acessos negados em 2 min, por projeto/ambiente/ator, ou IP quando ator ausente | Média |
| `ADMIN-001` | Mudança de privilégio ou ação crítica após ≥ 3 falhas de login para o mesmo ator em 10 min | Alta |

`ADMIN-001` usa lista de ações críticas da demo e requer identidade de ator; um simples acesso administrativo não gera alerta. Sucesso de login entre as falhas e a ação compõe a evidência, sem apagar o histórico.

Para cada regra/chave de correlação, manter um episódio ativo até passar uma janela inteira sem novo evento relevante. Eventos adicionais atualizam contagem e evidências sem criar alertas duplicados. O episódio e a unicidade de evidências devem ser persistidos; retry do mesmo evento não incrementa contadores. Resolver um alerta não abre outro dentro do mesmo episódio. Um novo episódio começa após o período de silêncio.

Regras determinísticas têm falsos positivos e não detectam toda atividade maliciosa. Resultado suspeito exige investigação. Cada regra terá cenários abaixo/no limiar, múltiplos projetos, eventos duplicados e períodos sem atividade.

## Superfície da API

Base `B = /v1/organizations/:orgId/projects/:projectId`; todas as rotas de negócio abaixo estão implementadas.

| Área | Rotas |
| --- | --- |
| Sessões | `POST /v1/auth/login`, `POST /v1/auth/logout`, `GET /v1/auth/session` |
| Projetos | `GET/POST /v1/organizations/:orgId/projects`, `GET B` |
| Chaves | `GET/POST B/keys`, `DELETE B/keys/:keyId` |
| Ingestão | `POST /v1/ingest/events` — credencial de máquina, sem sessão de usuário |
| Eventos | `GET B/events`, `GET B/events/:id` |
| Alertas | `GET B/alerts`, `GET/PATCH B/alerts/:id`, `GET B/alerts/:id/evidence` |
| Visão geral | `GET B/overview`, `GET B/stream` |
| Regras e auditoria | `GET B/rules`, `GET B/rule-settings`, `PATCH B/rule-settings/:code`, `GET /v1/organizations/:orgId/audit` |
| Resposta | `GET/POST B/response-keys`, `DELETE B/response-keys/:keyId`, `GET/POST B/alerts/:id/responses`; protocolo `/v1/response/commands` com credencial própria |
| Relatório | `GET B/alerts/:id/report`; download privado e sanitizado |
| Operação | `/health/live`, `/health/ready`; métricas restritas à operação |

Zod é a fonte do contrato TypeScript; validar a integração com JSON Schema, validação Fastify e geração OpenAPI no bootstrap. Schema, exemplos e respostas de erro não devem divergir. Consultar [validação e serialização do Fastify](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) antes de escolher o adaptador.

## Sessão, atualização e deploy

Sessões opacas no banco, cookies `HttpOnly`, `Secure` em HTTPS e `SameSite=Lax`; expiração, rotação após login e revogação no logout. Proteção CSRF e validação de origem em mutações. Nenhum token de sessão no localStorage.

Implementado na M5: frontend e API sob a mesma origem via proxy restrito (`/api` → Fastify). Cookies/Origin/CSRF são preservados; o proxy não aceita ingestão de máquina nem destinos arbitrários. SSE usa a sessão e o escopo, heartbeat, três conexões por usuário/64 por processo e fechamento quando sessão expira ou vínculo é revogado. Até reconectar verifica sessão sem renovar inatividade. Notificações vazias invalidam consultas; não há log de replay. Overview usa um snapshot SQL; a interface recupera o estado por GET após reconexão e tem fallback de 10 s. Detalhes e limitações em [DASHBOARD.md](DASHBOARD.md).

Desenvolvimento com Docker Compose: web, API, worker, PostgreSQL e demo. Deploy posterior com TLS, rede privada para banco/worker, secrets fora do Git, health checks, backup/restauração e política de retenção. Provedor e orçamento ficam em aberto até o marco de deploy; não haverá provisionamento pago na etapa de planejamento.

## Decisões e tradeoffs

M7: credencial de resposta separada permite consulta de comandos e confirmações somente no seu projeto/ambiente. A demo restaura bloqueios antes de atender HTTP e avalia TTL localmente. Definições de regras e revisões por projeto são append-only; o trigger captura seleção/ativação no job sob o mesmo lock da ingestão. Cada versão tem episódios próprios e o worker nunca aplica a configuração atual a jobs antigos. Relatórios projetam campos permitidos a partir de snapshots, com pseudônimos locais e auditoria. [Protocolo, limites e reprodução](RESPONSE.md).

M6: snapshots são capturados no banco, com backfill, e permanecem legíveis após retenção. Totais de receipts são transacionais; métricas usam horários reais de conclusão. Manutenção é privada, por escopo/lote e dry-run; serviços HTTP não recebem DELETE. A fila replica horário/ordem do recibo por trigger, com índices parciais pending/processing. Claim examina somente o primeiro job de cada projeto (`LATERAL ... LIMIT 1`); detector recebe SELECT apenas de `projects.id`. Ordem, leases e atomicidade são preservados. Polling pausa somente quando não há trabalho. [Operação](OPERATIONS.md) e [medição M6](milestones/M6.md).

- API Node.js e worker Python: demonstram integração entre linguagens com responsabilidades claras; custam contratos e operação de dois runtimes.
- SSE: suficiente para notificações do servidor ao dashboard; reduz complexidade de WebSocket, exige proxy compatível e recuperação por consulta.
- Fila no PostgreSQL: transação simples e recuperação durável; pode competir com consultas, por isso terá limites e métricas.
- Organizações desde o modelo inicial: torna testes de isolamento reais; não implica billing ou produto SaaS completo.
- Regras explícitas antes de ML: decisões reproduzíveis e explicáveis com poucos dados.
- Auditoria com inserção restrita: ajuda rastreabilidade, mas não é evidência imutável contra um administrador do banco.
