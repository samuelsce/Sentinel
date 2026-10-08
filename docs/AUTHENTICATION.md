# Identidade, autorização e credenciais — M2

Esta entrega implementa acesso pela API, administração de membros/projetos e emissão/revogação de chaves. A interface de login e o dashboard serão implementados na M5. A [M3](INGESTION.md) recebe eventos com essas chaves; a [M4](DETECTIONS.md) processa jobs e permite investigar/alterar alertas pela API com sessão, escopo e auditoria.

## Provisionar o primeiro administrador

Depois de iniciar o ambiente do [README](../README.md), execute em um terminal interativo:

```sh
docker compose run --rm -it migrate pnpm admin:provision
```

Informe email, deixe o UUID da organização vazio e informe seu nome. A nova organização recebe um administrador. A senha deve ter 15–128 caracteres e é digitada duas vezes, sem eco no terminal. Não existe senha padrão, seed de administrador, cadastro público ou parâmetro de senha em linha de comando.

O comando usa `DATABASE_URL` do serviço de migration, com privilégio de operador local. A API e o worker não recebem essa credencial. Se estiver desenvolvendo com dependências locais, o equivalente é `pnpm admin:provision`, depois de `pnpm db:migrate`.

Para criar outro usuário, repita o comando, informe o UUID da organização existente e escolha `admin`, `analyst` ou `reader`. Para vincular um usuário já existente a outra organização, sem redefinir sua senha:

```sh
docker compose run --rm -it migrate pnpm admin:provision -- --link
```

No modo `--link`, informe o email existente e o UUID de destino; também é possível criar uma organização com esse usuário como administrador. Um vínculo existente não é sobrescrito. Emails são normalizados para minúsculas. Falhas revertem a transação e produzem uma mensagem sanitizada. O operador possui acesso administrativo direto ao banco; proteja esse acesso como parte da operação.

## Sessões e CSRF

`POST /v1/auth/login` recebe JSON com `email` e `password`. Use um cliente HTTP que gerencie cookies, como Postman ou Bruno. Informe sua senha no cliente, sem colocá-la no histórico de comandos. Envie `Origin` igual ao `APP_ORIGIN` configurado, por padrão `http://localhost:3000`.

O login retorna `user`, `csrfToken` e `expiresAt`; o token de sessão fica exclusivamente no cookie `HttpOnly`. Login inválido retorna 401 genérico, independentemente da existência da conta. O corpo aceita apenas os campos documentados e tem limite de 8 KiB.

Para toda alteração autenticada, envie o cookie, `Origin` exato e `X-CSRF-Token` da sessão atual. A origem deve corresponder integralmente, sem correspondência parcial de domínio. Login também valida origem para evitar login CSRF. Requests com `Sec-Fetch-Site: cross-site` são rejeitadas. Não há CORS permissivo; o frontend futuro usará uma origem comum.

`GET /v1/auth/session` devolve os dados da própria sessão e permite recuperar seu token CSRF. Respostas de negócio usam `Cache-Control: no-store`. CSRF é um token sincronizador aleatório vinculado à sessão, armazenado no servidor; conhecer somente esse token não autentica um request.

Sessões possuem 256 bits aleatórios e são armazenadas por hash SHA-256 com domínio próprio. Expiram após 30 minutos sem uso ou 8 horas desde o login. Cada request autenticada verifica expiração/revogação e atualiza a atividade, sem estender o limite absoluto. Um novo login com o cookie anterior revoga aquela sessão e gera novos tokens de sessão/CSRF. Há no máximo dez sessões não revogadas por usuário; um novo login revoga as mais antigas quando necessário.

Cookie local: `sentinel_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, sem `Domain`. Para origem HTTPS: `__Host-sentinel_session` com `Secure` adicional. `NODE_ENV=production` exige `APP_ORIGIN` HTTPS. A exceção HTTP só aceita origens de loopback fora de produção. TLS e proxy de deploy ainda pertencem ao marco de publicação.

Referências: [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) e [plugin de cookies do Fastify](https://github.com/fastify/fastify-cookie).

## Senhas e limites de login

Senhas usam Argon2id, versão 19, salt aleatório da biblioteca, memória de **64 MiB**, **3 iterações**, paralelismo **1** e saída de 32 bytes, com `@node-rs/argon2` 2.2.2. A senha não é truncada. O mínimo de 15 caracteres segue o escopo atual sem MFA; o limite de 128 controla o tamanho de entrada.

A escolha parte da [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) e excede sua configuração mínima de Argon2id. Em 20 amostras sequenciais, após três aquecimentos, Node 24.20.0 no Windows e Intel i5-12400F: verificação p50 **60,92 ms**, p95 **68,33 ms**. O mínimo de 19 MiB/2 iterações mediu p50 8,87 ms e p95 10,51 ms no mesmo laboratório; optamos pelo custo maior, ainda confortável para login local. Isso mede somente a função de senha, não a latência HTTP ou capacidade de produção. Reavaliar no hardware de deploy. API admite até duas verificações de senha simultâneas por processo, limitando a memória dessas verificações a aproximadamente 128 MiB, além do overhead do runtime.

Contadores de login são atômicos no PostgreSQL e sobrevivem ao reinício da API:

| Escopo | Limite inicial | Janela |
| --- | --- | --- |
| Conta normalizada | 5 tentativas | 15 minutos |
| IP da conexão | 30 tentativas | 15 minutos |
| Global | 120 tentativas | 1 minuto |

As janelas são fixas e todas as tentativas com payload válido contam, inclusive logins válidos. Os limites global/IP são avaliados antes de criar o contador da conta. Os identificadores dos contadores são hashes, sem email/IP em texto claro. Contadores vencidos há mais de um dia são removidos periodicamente durante logins. Requests limitadas retornam 429 com `Retry-After`. `X-Forwarded-For` não altera o IP porque o proxy permanece não confiável.

Conta inexistente também verifica um hash Argon2id fictício. Isso reduz a diferença direta de custo entre senha inválida e conta inexistente, sem prometer igualdade de tempo absoluta. Rate limiting por conta pode causar negação de login direcionada; limites e estratégia deverão ser revisados com métricas antes de exposição pública. Limites gerais de ingestão/consultas serão tratados nos próximos marcos.

## Endpoints e papéis

IDs de organização, projeto, membro, sessão e chave são UUIDs. Todas as listagens têm limites fixos nesta etapa; paginação será ampliada com as consultas do dashboard.

| Método e caminho | Permissão | Resultado |
| --- | --- | --- |
| `POST /v1/auth/login` | Origem permitida; sem sessão | Login e cookie novo |
| `GET /v1/auth/session` | Sessão válida | Próprio usuário, CSRF e expiração |
| `POST /v1/auth/logout` | Sessão + CSRF | Revoga sessão e limpa cookie; 204 |
| `GET /v1/auth/sessions` | Sessão válida | Até 50 sessões do próprio usuário, sem tokens/hashes |
| `DELETE /v1/auth/sessions/:sessionId` | Próprio usuário + CSRF | Revoga sessão; 204 |
| `GET /v1/organizations` | Sessão válida | Até 100 organizações com vínculo ativo e papel atual |
| `GET /v1/organizations/:orgId/projects` | Qualquer papel ativo na organização | Até 100 projetos |
| `GET /v1/organizations/:orgId/projects/:projectId` | Qualquer papel ativo na organização | Projeto do escopo |
| `POST /v1/organizations/:orgId/projects` | Administrador + CSRF | Recebe `{name}`; projeto novo e auditoria; 201 |
| `GET /v1/organizations/:orgId/projects/:projectId/keys` | Administrador | Até 100 metadados de chaves |
| `POST /v1/organizations/:orgId/projects/:projectId/keys` | Administrador + CSRF | Recebe `{environment}`; segredo uma vez; 201 |
| `DELETE /v1/organizations/:orgId/projects/:projectId/keys/:keyId` | Administrador + CSRF | Revogação idempotente; 204 |
| `GET /v1/organizations/:orgId/members` | Administrador | Até 100 membros e papéis |
| `PATCH /v1/organizations/:orgId/members/:userId` | Administrador + CSRF | Recebe `{role, active}`; altera vínculo e audita; 204 |
| `GET /v1/organizations/:orgId/audit` | Administrador ou analista | Últimas 50 mudanças sanitizadas |

A organização vem do caminho, mas o servidor exige vínculo ativo do usuário autenticado. Consultas a objetos incluem organização e projeto. IDs externos e desconhecidos retornam o mesmo 404; papel insuficiente dentro da organização retorna 403. Os schemas são estritos: não é possível adicionar papel ou escopo ao payload de login/projeto/chave.

Mudanças de papel/inativação valem para requests subsequentes das sessões existentes. Não removem vínculos em outras organizações. Usuários desabilitados pelo operador perdem autenticação em todas as organizações. A API protege o último administrador ativo, inclusive contra duas remoções/rebaixamentos concorrentes, serializando as alterações por organização. Criar usuário, criar organização e adicionar vínculos são operações de provisionamento local nesta etapa.

## Chaves e auditoria

Chave: `snt_ing_<uuid>.<segredo aleatório>`. O prefixo público identifica a chave; o segredo contém 256 bits independentes. Apenas a emissão retorna a chave completa. O banco guarda seu hash SHA-256, prefixo, organização, projeto, ambiente, criação e revogação. Hash rápido é apropriado para esses segredos aleatórios; senhas humanas usam Argon2id.

Chaves não autenticam endpoints de sessão, administração ou investigação. A função interna `authenticateIngestionKey` verifica formato, hash e revogação e devolve somente o escopo persistido; é utilizada no endpoint de ingestão desde a M3.

Projeto, emissão/revogação de chave, provisionamento e mudança de membro registram auditoria transacional. Dados são allowlists: ação, IDs, papel, estado ativo e ambiente. Não há senha, token, hash ou payload livre na auditoria. `actorUserId: null` identifica a operação do provisionador local; requests autenticadas registram o usuário. Não é identificação individual do operador do sistema operacional. A API possui INSERT/SELECT na auditoria, sem UPDATE/DELETE; o migrator continua privilegiado. Não há promessa de armazenamento imutável contra o administrador do banco.

## Reproduzir a avaliação

```sh
pnpm install --frozen-lockfile
pnpm test:identity
```

O PostgreSQL do Compose precisa estar ativo. O script usa exclusivamente `sentinel_test`, aplica migrations duas vezes, provisiona fixtures aleatórias de duas organizações e três papéis, e faz requests reais à implementação Fastify pelo transporte de teste. As consultas de negócio usam o papel `sentinel_api`; o provisionamento/limpeza usa o migrator. As fixtures são removidas ao final, inclusive em falha. Não usa mocks de banco nem altera contas do banco `sentinel`.

O teste também injeta falha de auditoria no banco dedicado para provar rollback de mudanças. Um lock de laboratório evita duas execuções concorrentes do próprio teste. Veja resultados e limites no [relatório da M2](milestones/M2.md).
