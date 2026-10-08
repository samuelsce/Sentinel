# Operação local, retenção e métricas

A M6 usa PostgreSQL como fila durável, sem Redis. A API e o detector continuam com papéis restritos; somente o operador com `DATABASE_URL` do migrator executa manutenção. Nenhum endpoint HTTP permite purge.

## Retenção

```sh
pnpm ops:retain --project=UUID_DO_PROJETO
pnpm ops:retain --project=UUID_DO_PROJETO --batch=500 --apply
pnpm ops:retain --organization=UUID_DA_ORGANIZACAO
pnpm ops:retain --organization=UUID_DA_ORGANIZACAO --batch=500 --apply
pnpm ops:storage
```

Sem `--apply`, a transação é revertida e o relatório mostra quantas linhas seriam removidas. Cada execução remove no máximo 500 candidatos por classe por padrão (1–1000). Repetir deliberadamente até o relatório indicar zero; não existe agendamento automático nesta entrega. IDs podem ser consultados no dashboard ou no provisionamento privado.

| Classe | Política implementada |
| --- | --- |
| Eventos e respectivos jobs concluídos | Recebidos há mais de 30 dias; removidos juntos, somente quando o projeto não tem pending/processing |
| Jobs pending/processing/failed e seus eventos | Preservados; falhas exigem investigação do operador |
| Alertas e snapshots | Somente resolvidos, sem atualização ou evento relevante há 90 dias e sem trabalho pendente no projeto |
| Alertas abertos/triados | Preservados, inclusive além de 90 dias |
| Episódios sem alerta | 90 dias de inatividade e sem trabalho pendente no projeto |
| Auditoria | 90 dias; manutenção explícita por organização |
| Sessões/credenciais/quotas/totais | Esta rotina não os apaga |

Eventos normalizados têm metadata estrita; snapshots não capturam requests, passwords, headers ou corpos livres. Um trigger copia payload validado, horário de recebimento e ordem de ingestão ao criar cada evidência; o backfill da migration preserva evidências anteriores. A cópia independe do evento original, conserva a paginação e é imutável para API/detector. A identidade do evento e as decisões da regra permanecem explicáveis; a UI informa a expiração do original e retira o link que retornaria 404. O limite continua em 200 evidências por episódio, com sinalização de truncamento.

A manutenção trava o projeto e compartilha o lock curto de seleção do worker; usa transação, timeout de 10 s e `SKIP LOCKED`. Jobs em andamento não são descartados. A remoção física é privilegiada e não é reversível depois de `--apply`: o dry-run serve para revisão prévia. `ops:storage` mede bytes das relações no banco configurado, somente no comando privado. DELETE libera espaço para reutilização, sem garantir redução do arquivo no disco. Backups e arquivos exportados têm ciclo de vida próprio; a rotina não os purga. A M8 deverá definir backup/restauração e agendamento conforme o destino.

## Métricas privadas

`GET /v1/organizations/:orgId/projects/:projectId/metrics`, com sessão, admite administradores/analistas. Reader recebe 403; escopo externo, 404. O proxy `/api` permite a mesma rota. Não se usam chaves de ingestão para consultá-la.

- `ingestion`: accepted, duplicates e batches **confirmados desde a migration M6**. Contadores são atualizados na mesma transação que eventos/jobs; retries idênticos não aumentam accepted. Requests rejeitados não entram nesses contadores. Não se inventa histórico anterior.
- `queue`: pending, processing, failed, completed24h, retried (jobs retidos com mais de uma tentativa), idade do pending mais antigo e p95 do tempo entre criação e conclusão nos últimos 24 h. Sem amostras, latência e idade são `null`. Conclusões anteriores à M6 não têm timestamp e não entram nessa distribuição.
- `/health/live` e `/health/ready` continuam mínimos. Métricas não expõem payload, identificadores dos atores, credenciais ou mensagens SQL.

## Medição reproduzível

```sh
pnpm install --frozen-lockfile
uv sync --project services/detector --locked --python 3.12.14
pnpm test:operations
pnpm lab:benchmark
```

O benchmark exige `sentinel_test`, provisiona seu próprio projeto e o remove no final. Executar **serialmente**, sem outras suites de banco: elas compartilham recursos e limites de laboratório. Envia 100 eventos benignos por HTTP a cada 2 s durante 600 s, reinicia seu worker após 300 s, compara IDs confirmados com persistidos e mede consultas de 50 eventos em corpus de 100 mil. O complemento até 100 mil é fixture SQL identificada como tal, sem contar como ingestão HTTP. Relatório sanitizado em [validation/m6-lab.json](validation/m6-lab.json); metodologia e limites em [milestones/M6.md](milestones/M6.md). A visibilidade de alerta medida por polling HTTP não equivale ao tempo de pintura no browser.

O script não muda limites do produto (60 requests/min, 3000 eventos/min, backlog máximo de 10000). Entre fases, o operador zera apenas o bucket de quota do projeto descartável. Após reiniciar, mantém a carga e mede retorno da fila a até um lote, sem pausar para drenagem nem criar bursts de compensação. Depois da carga, mede drenagem a zero. Latência de ingestão considera somente receipts 202. O operador do banco de testes tem 120 s para preparo/limpeza; API continua com 3 s. Ao preencher o backlog, o coletor responde 503; clientes devem respeitar retry/limites.

## Segurança automatizada

CI executa Semgrep 1.180.0 com seis regras locais versionadas, regressões positivas, métricas externas desligadas e falha em findings/erros; `pnpm audit --audit-level low` e `pip-audit` 2.10.1 sobre dependências transitivas exportadas do lockfile com hashes. Inclui ferramentas de desenvolvimento na auditoria. O build público é inspecionado contra padrões de credenciais de ingestão/PostgreSQL. Falhas de rede/auditoria bloqueiam o check, sem transformar indisponibilidade em resultado limpo. Não há lista de vulnerabilidades ignoradas.

A regra esbuild transitiva do loader Drizzle foi corrigida por override restrito para 0.28.2 em `pnpm-workspace.yaml`, conforme [advisory GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) e [configuração pnpm](https://pnpm.io/settings). Referências das ferramentas: [Semgrep](https://docs.semgrep.dev/running-rules) e [pip-audit](https://github.com/pypa/pip-audit). SAST local tem escopo explícito e não substitui os testes de isolamento/abuso nem uma revisão externa.
