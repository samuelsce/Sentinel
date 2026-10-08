# Detecção e investigação — M4

Implementado: consumo durável dos jobs, três regras determinísticas versionadas, episódios/evidências persistidos e investigação pela API. O dashboard e SSE pertencem à M5. Um `202` de ingestão confirma persistência; não confirma processamento nem a existência de alerta.

## Regras v1

Fonte de parâmetros: [security-rules.v1.json](../packages/contracts/rules/security-rules.v1.json). As migrations registram as definições no banco; reaplicar exige igualdade com a versão existente. Alterações de parâmetros exigem nova versão. O worker confere as definições antes de processar. A configuração por projeto ainda não existe.

| Código | Gatilho | Correlação dentro do projeto/ambiente | Severidade |
| --- | --- | --- | --- |
| AUTH-001 | ≥ 5 falhas de login em 300 s | IP; ator quando IP ausente | Alta |
| AUTHZ-001 | ≥ 10 acessos negados em 120 s | Ator; IP quando ator ausente | Média |
| ADMIN-001 | Mudança de privilégio bem-sucedida, ou ação crítica bem-sucedida após ≥ 3 falhas em 600 s | Ator obrigatório | Alta |

Ações críticas: `change_settings`, `rotate_key`, `disable_user`, `export_report`. `create_user` sem mudança de privilégio explícita não dispara a regra. Login bem-sucedido entre falhas e ação entra como contexto e não apaga o histórico. Sem identificador a regra não correlaciona; IPs IPv6 equivalentes são normalizados. Uma mudança explícita de privilégio não exige falhas anteriores e registra limiar zero.

As janelas usam **received_at**, atribuído pela API após obter o lock do projeto. O `occurred_at` do emissor continua na evidência, mas não controla contagem. Limites da janela são inclusivos. `ingest_order`, uma sequência do banco, preserva a ordem dos eventos de um lote quando os timestamps coincidem; UUID não estabelece causalidade. O worker percorre `(received_at, ingest_order)`. Relógios das réplicas da API precisam estar sincronizados; correção de relógios e eventos retroativos de operadores não são tratados como replay histórico.

## Episódios e explicação

Há um episódio ativo por projeto, ambiente, código/versão e correlação. Um intervalo **maior** que a janela sem evento relevante encerra o episódio quando chega o próximo evento relevante. O encerramento é registrado com o instante lógico de silêncio; não há timer de fechamento.

Cruzar o gatilho cria um único alerta por episódio. Novos eventos atualizam evidências e pico de contagem. Resolver não reabre o alerta nem cria outro no mesmo episódio. Após silêncio, um novo episódio pode gerar outro alerta. Eventos duplicados não criam jobs nem incrementam contagens; tentativas com rollback também não incrementam.

Cada alerta contém `ruleCode`, `ruleVersion`, correlação, severidade, estado, `statusVersion`, episódio, `initialDecision`, `lastDecision` e `peakCount`. A decisão registra janela, base temporal, limiar, contagem, motivo e ID do evento que disparou. A decisão inicial é preservada; a última decisão só muda quando outro evento satisfaz o gatilho. `totalRelevant` conta eventos relevantes do episódio, não necessariamente a contagem da janela.

Evidências possuem papéis `trigger`, `support` e `context`, com IDs únicos e relações compostas que impedem associar outra organização/projeto/ambiente. O limite é **200 eventos por alerta**, preservando as evidências já vinculadas e priorizando o gatilho inicial. `evidenceTruncated=true` sinaliza o limite. Contagens continuam exatas; um gatilho posterior sem espaço continua identificado na decisão e pode ser consultado na rota de evento. Evidências acumuladas podem estar fora da última janela: consulte a decisão correspondente. Retenção e limpeza estão pendentes na M6.

## Fila, falhas e recuperação

- Claim transacional com `SKIP LOCKED` e lock consultivo curto para serializar a seleção entre workers.
- Um job por projeto em processamento; projetos diferentes podem avançar em paralelo. A cabeça em retry bloqueia eventos posteriores do projeto para preservar a ordem causal.
- Lease de **30 s**, token aleatório por tentativa e **5 tentativas** máximas. Claim expirado pode ser retomado.
- Episódio, alerta, evidências e conclusão do job são gravados juntos. Token/validade do lease são conferidos antes e no final da transação. Resultado de worker antigo não pode ser confirmado.
- Erro estrutural: `failed/invalid_event`. Erro recuperável: `pending/processing_error`, com atraso de 2, 4, 8 e 16 s entre tentativas. Após esgotamento: `failed/processing_error`; lease esgotado: `failed/lease_exhausted`.
- Mensagens SQL, payloads, senhas, chaves e tokens de lease não entram nos diagnósticos. Falha de conexão faz o processo reconectar; claim abandonado aguarda expiração.

O worker usa o papel `sentinel_detector`: lê eventos/jobs/regras, grava detecções e altera somente as colunas permitidas. Não lê usuários/sessões, não altera eventos, estados de triagem ou definições. A API altera estado/versão, mas não as decisões do detector.

Com o ambiente completo ativo, o worker processa continuamente. Para diagnóstico local:

```sh
docker compose exec -T detector uv run --no-sync sentinel-detector --check
docker compose logs --tail=50 detector
```

Modo manual, com dependências Python locais instaladas:

```sh
cd services/detector
uv run --env-file ../../.env --no-sync sentinel-detector --drain --project UUID_DO_PROJETO
```

`--drain` processa até 10.000 jobs elegíveis e termina quando não há claim disponível. Não aguarda delays futuros nem leases ainda válidos; não significa que todo backlog terminou. `--project` é filtro operacional local, não um endpoint público. Não execute vários workers sem considerar os limites do PostgreSQL.

## API de investigação

Base: `/v1/organizations/:orgId/projects/:projectId`. Todas as rotas exigem sessão e vínculo ativo; chave de ingestão não serve como sessão. Organização inacessível, projeto externo ou recurso inexistente retornam 404. Papel insuficiente retorna 403.

| Método e sufixo | Papel | Resultado |
| --- | --- | --- |
| GET `/events` | Todos | Página, filtros `environment`, `type`, `from`, `to` (recebimento) |
| GET `/events/:eventId` | Todos | Evento validado e instante de recebimento |
| GET `/alerts` | Todos | Página, filtros `environment`, `ruleCode`, `status` |
| GET `/alerts/:alertId` | Todos | Detalhe completo e auditoria `alert.viewed` |
| GET `/alerts/:alertId/evidence` | Todos | Timeline de evidências, em ordem de recebimento |
| PATCH `/alerts/:alertId` | admin / analyst | Estado com auditoria `alert.status_changed` |
| GET `/rules` | Todos | Metadados das definições versionadas |
| GET `/jobs` | admin / analyst | Diagnóstico paginado, `status` padrão `failed` |

Listas aceitam `limit` de 1–100 (padrão 50) e `cursor` devolvido em `nextCursor`. Cursores guardam escopo, filtros e posição, preservando microssegundos do PostgreSQL. Trocar escopo/filtros ou usar cursor malformado retorna 400. O cursor não é uma credencial e não concede autorização. Páginas não são snapshots: novas evidências e mudanças de filtro de estado podem alterar o conjunto entre consultas. Listar alertas/evidências não cria auditoria; abrir detalhe cria.

Para mudar estado, envie cookie de sessão, `Origin` permitido, `X-CSRF-Token` e JSON:

```json
{ "status": "triaged", "expectedVersion": 1 }
```

Estados: `open`, `triaged`, `resolved`; reabrir manualmente é permitido. Resposta inclui `statusVersion`. Versão desatualizada retorna 409: consulte novamente antes de decidir. Repetir o mesmo estado com a versão atual é no-op. Mudança de estado e auditoria são atômicas; vínculo/papel é conferido novamente dentro da transação. Respostas têm `Cache-Control: no-store`. Jobs expõem contagens e códigos de erro, sem payload ou token de lease.

## Reproduzir a entrega

Instale dependências Node e Python conforme [README](../README.md), inicie PostgreSQL e execute:

```sh
pnpm test:detection
```

O comando recusa banco diferente de `sentinel_test`, aplica migrations duas vezes, usa papéis reais e remove suas fixtures. Executa 10 cenários Python de banco e 11 cenários da API, incluindo demo → SDK → HTTP → fila → três alertas, investigação, auditoria, paginação, duplicatas, estado resolvido e revogação de vínculo.

No laboratório manual, `pnpm demo:scenario` gera 22 eventos: 6 falhas do reader, 3 do admin, 2 sucessos, 10 acessos negados e 1 ação crítica do admin. Em projeto novo e com worker ativo, espere três alertas, um por regra. Repetições dentro das janelas atualizam episódios existentes. Crie/vincule um usuário Sentinel à organização retornada por `demo:setup` usando `admin:provision`; use o fluxo de sessão de [AUTHENTICATION.md](AUTHENTICATION.md) para consultar estas rotas. As credenciais de login da demo pertencem somente à demo.

Estas regras são indicadores de laboratório com falsos positivos: senha esquecida, NAT com usuários distintos, erros de permissão e manutenção administrativa podem produzir alertas. Não representam prova de ataque, cobertura completa ou metas de desempenho verificadas. UI, SSE, métricas de carga/p95, retenção e resposta continuam planejados.
