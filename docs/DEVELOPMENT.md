# Ambiente e desenvolvimento

## Versões fixadas

Versões consultadas nos registros oficiais dos pacotes e compatibilidade validada por instalação, typecheck, testes e build em 8 de outubro de 2026.

| Componente | Versão de referência | Onde está fixado |
| --- | --- | --- |
| Node.js | 24.20.0, linha LTS 24 | `.node-version` e imagem Docker por digest |
| pnpm | 11.25.0 | `packageManager`, Dockerfile e CI |
| Next.js / React | 16.4.0 / 19.3.0 | `apps/web/package.json` e lockfile |
| Tailwind / TanStack Query | 4.3.3 / 5.104.1 | web e lockfile; M5 |
| Lucide / Playwright | 1.52.0 / 1.64.0 | web/raiz e lockfile; M5 |
| TypeScript | 5.9.3 | `package.json` e lockfile |
| Fastify | 5.12.5 | `apps/api/package.json` e lockfile |
| Zod / provider | 4.6.5 / fastify-type-provider-zod 7.0.0 | packages e lockfile |
| Swagger | @fastify/swagger 9.9.1 | API e lockfile |
| Senhas / cookies | @node-rs/argon2 2.2.2 / @fastify/cookie 11.1.2 | API e lockfile; adicionados na M2 |
| PostgreSQL | 18.6 | Imagem de `compose.yaml` fixada por digest |
| Drizzle ORM / Kit | 0.45.3 / 0.31.11 | package database e lockfile |
| Python / uv | 3.12.14 / 0.12.23 | `.python-version`, Dockerfile e CI |
| psycopg / jsonschema | 3.3.6 / 4.26.0 | `uv.lock` |
| Vitest / pytest | 5.0.3 / 9.1.1 | lockfiles |

Node 24 foi escolhido como linha LTS: [ciclo oficial de releases](https://nodejs.org/en/about/previous-releases). Next exige Node a partir de 20.9: [instalação oficial](https://nextjs.org/docs/app/getting-started/installation). Fastify 5 exige Node 20+: [guia de migração](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/). A versão 24 satisfaz ambos e Vitest 5; TypeScript 5.9.3 foi mantido após validar esta combinação.

## Estrutura atual

`apps/api` contém identidade, ingestão, investigação, overview/SSE e health checks; `apps/web`, login, dashboard e proxy restrito; `apps/demo`, o laboratório HTTP instrumentado; `services/detector`, o worker privado; `packages/contracts`, contrato/schemas/fixtures; `packages/database`, schema/migrations/conexão; `packages/sdk`, cliente Node.js. `infra` contém imagens e inicializador de papéis do banco. [Ingestão](INGESTION.md) e [dashboard](DASHBOARD.md).

Pacotes internos TypeScript exportam fontes para o monorepo; tsx executa a API/migrations. As imagens M1 incluem ferramentas de desenvolvimento e não são as imagens finais de produção. O build verifica os pacotes e gera o frontend otimizado.

## Configuração e segredos

`node scripts/setup.mjs` ou `pnpm env:init` cria `.env` na raiz, com senhas aleatórias diferentes para migrator, API e detector. Execuções posteriores preservam o arquivo. `.env.example` documenta variáveis; `.gitignore` e `.dockerignore` excluem segredos.

O PostgreSQL usa um usuário privilegiado de bootstrap/migrations, que fica fora da API e do worker. O inicializador cria `sentinel_api` e `sentinel_detector`, sem superuser/bypass de RLS. Após migrations, API recebe permissões nas tabelas de identidade/ingestão e somente SELECT/INSERT na auditoria. Na M4, consulta detecções e altera somente estado/versão/data dos alertas. Detector lê eventos/jobs/regras, altera jobs e grava episódios/alertas/evidências; não pode alterar estado de triagem ou definições. Não lê senhas/sessões nem altera eventos. [Permissões e recuperação](DETECTIONS.md). Retenção pertence à M6.

O arquivo `.env` e os volumes persistentes formam um par. Gerar senhas novas não muda as senhas já gravadas no volume. Não apague o volume de um ambiente com dados para resolver acesso: restaure a configuração ou faça uma rotação administrativa. O inicializador roda somente em volume vazio.

O banco `sentinel_test` é criado no bootstrap para testes. `test:database` recusa URLs que não apontem para ele, aplica migrations e reverte as linhas de teste. Não usar banco de produção nestes comandos.

## Serviços e health checks

Ordem Compose: PostgreSQL saudável → migration concluída → API/worker → web.

- API `/health/live`: processo disponível, sem depender de banco.
- API `/health/ready`: banco acessível e tabelas de eventos, sessões, contadores e auditoria existentes; retorna 503 em falha.
- Detector `sentinel-detector --check`: carrega/verifica schema, checa banco/tabela e sai com 0/1.
- Web: responde e consulta readiness a cada abertura, sem cache de resultado.

O worker da M4 reivindica jobs e processa detecções continuamente. Readiness verifica o banco/schema e a definição versionada; não comprova ausência de backlog nem substitui os testes de detecção. [Operação, recuperação e investigação](DETECTIONS.md).

Portas do host são locais: 3000, 3001, 55432. `POSTGRES_PORT` pode ser alterado junto das URLs locais em `.env`. As URLs internas do Compose continuam usando `postgres:5432`. `API_INTERNAL_URL` é exclusivamente do servidor Next.js, sem exposição de credenciais ao navegador.

## Migrations e contrato

Drizzle é a única ferramenta de migrations; Python não administra schema. Gerar SQL com `pnpm db:generate`, revisar e versionar migration/snapshot/journal. Aplicar com `pnpm db:migrate`. Não usar `drizzle push` em ambientes persistentes. Referência: [fluxos de migration do Drizzle](https://orm.drizzle.team/docs/migrations).

Zod exporta schemas Draft 2020-12 com `pnpm contracts:generate`; verificar com `pnpm contracts:check`. Fixtures são compartilhadas entre Zod, Ajv e Python. Regras temporais e limites de transporte ficam separados da validação estrutural. [Detalhes do contrato](CONTRACTS.md).

Fastify usa provider Zod e schemas de resposta; Swagger é registrado antes das rotas. Os testes conferem a especificação OpenAPI em memória. A especificação ainda não possui rota HTTP pública; a ingestão autenticada está disponível desde a M3. Referência: [validação e serialização do Fastify](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/).

## Logs e falhas

Logs da API usam JSON estruturado e omitem body, headers e query strings. A M2 registra somente o template de rota (ou `/unmatched`), sem parâmetros de caminho enviados pelo usuário. Mensagens de erro e 404 não incluem o payload nem a URL completa. Os testes cobrem segredos fictícios em query, caminho, Authorization, cookie e body. Readiness e migrations não imprimem exceções contendo a URL do banco. Detector imprime somente serviço/marco/estado quando o estado muda.

## CI

O workflow usa três jobs: checks/build TypeScript; lint/testes Python; Compose/migrations/identidade/ingestão/detecção/smoke PostgreSQL. Todos usam dependências travadas; actions são fixadas por commit e permissões são `contents: read`. Nenhum secret de deploy é necessário. O serviço de migration deve terminar com 0, enquanto os serviços de longa duração devem ficar saudáveis. Entregas usam branch separada e PR; a main recebe apenas mudanças revisadas. `test:identity`, `test:ingestion` e `test:detection` usam o banco dedicado e os papéis reais, provisionam fixtures temporárias e as removem ao final. O último precisa de `uv sync --locked --python 3.12.14` em `services/detector` para instalar seu executor Python.

Na M5 o job de integração também executa `pnpm test:live` e `pnpm test:web`, com Chromium instalado por Playwright. Para reproduzir: instalar Python/uv, aplicar migrations, gerar `pnpm build`, instalar `pnpm exec playwright install chromium` (`--with-deps` no Linux) e executar os testes em sequência. O navegador usa Next.js em modo de produção na porta 3300; a API escuta em porta aleatória somente local. Credenciais temporárias são passadas ao processo de teste, sem argumentos/logs. Trace/video ficam desligados; screenshots usam dados fictícios e mascaram a conta. Artefatos temporários ficam em `test-results/`, ignorado pelo Git. O teste libera os serviços e remove os dados ao final.

## Identidade da M2

O novo `APP_ORIGIN` possui valor local padrão `http://localhost:3000`; arquivos `.env` existentes continuam funcionando. Ao utilizar outro host/origem, ajuste essa variável. Produção exige HTTPS; não use origens HTTP públicas. `pnpm admin:provision` requer terminal interativo e a credencial de migration; a alternativa Compose e o fluxo completo estão em [AUTHENTICATION.md](AUTHENTICATION.md).

Migrations adicionais criam sessões, contadores de login e auditoria e acrescentam estado de usuário/vínculo. API recebe SELECT/INSERT/UPDATE em sessões/contadores e DELETE somente nos contadores; auditoria recebe SELECT/INSERT. Detector continua sem acesso a usuários, sessões ou auditoria. Provisionamento usa transação e senha Argon2id; nenhum seed pessoal entra na CI.

## Recuperação comum

M6: `pnpm test:operations` verifica oito cenários adicionais. `pnpm lab:benchmark` ocupa pelo menos dez minutos e usa um projeto descartável em `sentinel_test`; não execute outra suite de banco em paralelo. `pnpm ops:retain` é privado, exige escopo e simula por padrão; `--apply` efetiva o purge. `pnpm ops:storage` mede relações sem expor dados. [Guia operacional](OPERATIONS.md). O teste web agora cobre nove jornadas e originais expirados; gerar novo build após alterações da UI.

- Docker indisponível: iniciar Docker Desktop/Engine e selecionar containers Linux.
- Porta ocupada: encerrar a instância local do Sentinel que usa a mesma porta ou ajustar configuração de ambos os lados.
- API indisponível na tela: conferir `docker compose ps -a` e logs; migration deve concluir antes da API.
- Schema divergente: regenerar contratos e testar TypeScript/Python; não editar JSON gerado à mão.
- Windows sem Python funcional no PATH: usar o interpreter gerenciado pelo uv ou executar o worker pelo Compose. Não é necessário alterar proteções do sistema.

M7: `pnpm test:response` executa 18 cenários de resposta/configuração/exportação no banco isolado. A suite web agora tem 11 jornadas. Recompile a UI antes de executar; mantenha as suites de banco em sequência. O protocolo de máquina não passa pelo proxy do navegador e usa uma credencial independente. [Reprodução e atualização de configuração da demo](RESPONSE.md).
