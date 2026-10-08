# Contrato de eventos v1

Implementado na M1 em [packages/contracts](../packages/contracts). O contrato define o payload futuro do SDK/ingestão, sem expor um endpoint de envio nesta etapa. Autenticação e ingestão HTTP serão implementadas em M2/M3.

## Uma fonte de verdade

Zod 4 define as variantes TypeScript. `pnpm contracts:generate` exporta JSON Schema Draft 2020-12; o worker Python lê esses mesmos arquivos com jsonschema e FormatChecker. A geração usa a representação de entrada, sem transforms ou refinements que não possam ser representados no schema.

`pnpm contracts:check` falha quando os arquivos gerados divergem do código. Os testes Zod/Ajv e Python utilizam as mesmas [fixtures](../packages/contracts/fixtures/events.v1.json), incluindo casos inválidos. A fixture contém um evento base, sobrescritas de campos e uma lista de campos removidos; ambos os runtimes constroem o mesmo payload antes da validação.

## Exemplo de falha de login

```json
{
  "schema_version": 1,
  "event_id": "5c7f7a62-c7b4-4c3d-982b-b1617e7ec105",
  "type": "auth.login_failed",
  "occurred_at": "2026-10-08T12:00:00Z",
  "environment": "demo",
  "actor_id": "user-42",
  "source_ip": "192.0.2.10",
  "resource": "/login",
  "action": "log_in",
  "outcome": "failure",
  "metadata": { "reason": "invalid_credentials" }
}
```

Campos obrigatórios comuns: `schema_version`, `event_id`, `type`, `occurred_at`, `environment`, `action`, `outcome` e `metadata`. Ator é obrigatório nos eventos administrativos. ID de evento é UUID; timestamp deve ser ISO UTC com `Z`. Campos opcionais devem ser omitidos quando ausentes, sem `null`.

`actor_id`, `request_id` e identificadores em metadata aceitam caracteres ASCII alfanuméricos, `_`, `.`, `:`, `-`, com limite de 128 caracteres. Isso permite IDs pseudônimos sem aceitar email como identificador. `resource` é caminho normalizado de até 160 caracteres, sem query string, espaços ou HTML. IP aceita IPv4/IPv6.

Ambientes: `demo`, `development`, `test`, `staging`, `production`. O ambiente permitido pela credencial será verificado na ingestão; o schema por si só não autentica o emissor.

## Variantes e allowlists

| Tipo | Action / outcome | Metadata permitido |
| --- | --- | --- |
| `auth.login_failed` | `log_in` / `failure` | `reason`: `invalid_credentials` ou `account_locked`, opcional |
| `auth.login_succeeded` | `log_in` / `success` | `auth_method`: `password`, `passkey` ou `mfa`, opcional |
| `authz.access_denied` | `access_resource` / `failure` | `permission`: identificador; `reason`: `insufficient_role` ou `resource_policy`, opcionais |
| `admin.action` | `create_user`, `disable_user`, `change_settings`, `rotate_key`, `export_report` / `success` ou `failure` | `target_id`: identificador opcional |
| `admin.privilege_changed` | `change_privilege` / `success` | `target_id`, `previous_role`, `new_role`, obrigatórios |

Papéis declarados pela aplicação: `user`, `admin`, `service`. Não são permissões do Sentinel. Todos os objetos são estritos: propriedades desconhecidas são rejeitadas. Metadata de uma variante não é aceita em outra.

## Limites estruturais e operacionais

Envelope de lote: `{ "events": [...] }`, de 1 a 100 eventos, sem propriedades extras.

O contrato estrutural não implementa autenticação, deduplicação, limite de bytes do request ou acesso ao banco. A M3 aplicará até 8 KiB por evento, 256 KiB por request, quota por chave e IDs únicos por projeto. Não armazenar chaves, senhas, cookies ou corpos de requisição em metadata. Allowlist limita campos, mas não comprova que um emissor escreveu dados legítimos dentro de um campo permitido.

A função TypeScript `isEventWithinTimeWindow` verifica a janela operacional em relação ao horário de recebimento: até 24 horas no passado e 2 minutos no futuro. É testada com relógio determinístico e fica separada do JSON Schema. O worker não revalida essa janela relativa ao seu horário de processamento; a ingestão deverá decidir a admissibilidade no momento do recebimento.

## Compatibilidade

Uma mudança incompatível requer nova `schema_version`, novos arquivos de schema e fixtures. Não editar JSON Schema gerado à mão. Uma mudança compatível ainda exige regeneração e execução dos testes nos dois runtimes. Documentar exemplos e atualizar este arquivo junto do código.

Referência técnica: [Zod — JSON Schema](https://zod.dev/json-schema). A escolha de manter validação temporal fora do schema é uma decisão do Sentinel para preservar compatibilidade entre linguagens.
