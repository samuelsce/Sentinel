# Ambiente e desenvolvimento

## Versões fixadas

Versões consultadas nos registros oficiais dos pacotes e compatibilidade validada por instalação, typecheck, testes e build em 8 de outubro de 2026.

| Componente | Versão de referência | Onde está fixado |
| --- | --- | --- |
| Node.js | 24.20.0, linha LTS 24 | `.node-version` e imagem Docker por digest |
| pnpm | 11.25.0 | `packageManager`, Dockerfile e CI |
| Next.js / React | 16.4.0 / 19.3.0 | `apps/web/package.json` e lockfile |
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

`apps/api` contém identidade, autorização, projetos, chaves e health checks; `apps/web`, a tela inicial; `services/detector`, o worker privado; `packages/contracts`, o contrato e seus schemas/fixtures; `packages/database`, schema, migrations e conexão. `infra` contém imagens e inicializador de papéis do banco. Demo e SDK serão criados na M3.

Pacotes internos TypeScript exportam fontes para o monorepo; tsx executa a API/migrations. As imagens M1 incluem ferramentas de desenvolvimento e não são as imagens finais de produção. O build verifica os pacotes e gera o frontend otimizado.

## Configuração e segredos

`node scripts/setup.mjs` ou `pnpm env:init` cria `.env` na raiz, com senhas aleatórias diferentes para migrator, API e detector. Execuções posteriores preservam o arquivo. `.env.example` documenta variáveis; `.gitignore` e `.dockerignore` excluem segredos.

O PostgreSQL usa um usuário privilegiado de bootstrap/migrations, que fica fora da API e do worker. O inicializador cria `sentinel_api` e `sentinel_detector`, sem superuser/bypass de RLS. Após migrations, API recebe SELECT/INSERT/UPDATE nas tabelas de negócio e somente SELECT/INSERT na auditoria; detector recebe SELECT em eventos/jobs e UPDATE em jobs. Detector não lê senhas/sessões nem altera eventos. Autorização por usuário foi implementada na M2; retenção pertence à M6.

O arquivo `.env` e os volumes persistentes formam um par. Gerar senhas novas não muda as senhas já gravadas no volume. Não apague o volume de um ambiente com dados para resolver acesso: restaure a configuração ou faça uma rotação administrativa. O inicializador roda somente em volume vazio.

O banco `sentinel_test` é criado no bootstrap para testes. `test:database` recusa URLs que não apontem para ele, aplica migrations e reverte as linhas de teste. Não usar banco de produção nestes comandos.

## Serviços e health checks

Ordem Compose: PostgreSQL saudável → migration concluída → API/worker → web.

- API `/health/live`: processo disponível, sem depender de banco.
- API `/health/ready`: banco acessível e tabelas de eventos, sessões, contadores e auditoria existentes; retorna 503 em falha.
- Detector `sentinel-detector --check`: carrega/verifica schema, checa banco/tabela e sai com 0/1.
- Web: responde e consulta readiness a cada abertura, sem cache de resultado.

O worker permanece em estado `idle` na M2 e não reivindica jobs. Os checks não prometem que detecção esteja pronta e não substituem os testes de autenticação.

Portas do host são locais: 3000, 3001, 55432. `POSTGRES_PORT` pode ser alterado junto das URLs locais em `.env`. As URLs internas do Compose continuam usando `postgres:5432`. `API_INTERNAL_URL` é exclusivamente do servidor Next.js, sem exposição de credenciais ao navegador.

## Migrations e contrato

Drizzle é a única ferramenta de migrations; Python não administra schema. Gerar SQL com `pnpm db:generate`, revisar e versionar migration/snapshot/journal. Aplicar com `pnpm db:migrate`. Não usar `drizzle push` em ambientes persistentes. Referência: [fluxos de migration do Drizzle](https://orm.drizzle.team/docs/migrations).

Zod exporta schemas Draft 2020-12 com `pnpm contracts:generate`; verificar com `pnpm contracts:check`. Fixtures são compartilhadas entre Zod, Ajv e Python. Regras temporais e limites de transporte ficam separados da validação estrutural. [Detalhes do contrato](CONTRACTS.md).

Fastify usa provider Zod e schemas de resposta; Swagger é registrado antes das rotas. Os testes conferem a especificação OpenAPI em memória. A M1 não publica documentação HTTP nem endpoint de ingestão antes da autenticação. Referência: [validação e serialização do Fastify](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/).

## Logs e falhas

Logs da API usam JSON estruturado e omitem body, headers e query strings. A M2 registra somente o template de rota (ou `/unmatched`), sem parâmetros de caminho enviados pelo usuário. Mensagens de erro e 404 não incluem o payload nem a URL completa. Os testes cobrem segredos fictícios em query, caminho, Authorization, cookie e body. Readiness e migrations não imprimem exceções contendo a URL do banco. Detector imprime somente serviço/marco/estado quando o estado muda.

## CI

O workflow usa três jobs: checks/build TypeScript; lint/testes Python; Compose/migrations/identidade/smoke PostgreSQL. Todos usam dependências travadas; actions são fixadas por commit e permissões são `contents: read`. Nenhum secret de deploy é necessário. O serviço de migration deve terminar com 0, enquanto os serviços de longa duração devem ficar saudáveis. Entregas usam branch separada e PR; a main recebe apenas mudanças revisadas. `test:identity` usa o banco dedicado e o papel real da API, provisiona fixtures temporárias e as remove ao final.

## Identidade da M2

O novo `APP_ORIGIN` possui valor local padrão `http://localhost:3000`; arquivos `.env` existentes continuam funcionando. Ao utilizar outro host/origem, ajuste essa variável. Produção exige HTTPS; não use origens HTTP públicas. `pnpm admin:provision` requer terminal interativo e a credencial de migration; a alternativa Compose e o fluxo completo estão em [AUTHENTICATION.md](AUTHENTICATION.md).

Migrations adicionais criam sessões, contadores de login e auditoria e acrescentam estado de usuário/vínculo. API recebe SELECT/INSERT/UPDATE em sessões/contadores e DELETE somente nos contadores; auditoria recebe SELECT/INSERT. Detector continua sem acesso a usuários, sessões ou auditoria. Provisionamento usa transação e senha Argon2id; nenhum seed pessoal entra na CI.

## Recuperação comum

- Docker indisponível: iniciar Docker Desktop/Engine e selecionar containers Linux.
- Porta ocupada: encerrar a instância local do Sentinel que usa a mesma porta ou ajustar configuração de ambos os lados.
- API indisponível na tela: conferir `docker compose ps -a` e logs; migration deve concluir antes da API.
- Schema divergente: regenerar contratos e testar TypeScript/Python; não editar JSON gerado à mão.
- Windows sem Python funcional no PATH: usar o interpreter gerenciado pelo uv ou executar o worker pelo Compose. Não é necessário alterar proteções do sistema.
