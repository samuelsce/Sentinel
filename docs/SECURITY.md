# Segurança: controles implementados e evolução

M1 implementou integridade do banco, papéis de serviço, contratos e logs sanitizados. M2 implementou sessões/CSRF/escopo: [identidade](AUTHENTICATION.md). M3 implementou [ingestão/SDK](INGESTION.md); M4 [detecções/investigação](DETECTIONS.md); M5 [dashboard/proxy/SSE](DASHBOARD.md). M6 implementou [retenção/snapshots/métricas](OPERATIONS.md), análise estática/dependências e abuso adicional. M7 implementou [resposta temporária, regras e relatório sanitizado](RESPONSE.md). Este documento não representa certificação ou auditoria independente.

## Ativos e limites de confiança

Ativos: credenciais de ingestão, sessões, eventos, evidências de alerta, vínculos de organização e auditoria. Eventos podem conter IPs e identificadores de usuários; a demo usa dados fictícios.

Fronteiras: navegador → API; aplicação monitorada → ingestão; API → banco; banco → worker. Sessões de usuário e chaves de máquina têm permissões distintas. A aplicação integrada pode emitir dados incorretos: uma chave válida autentica a origem, não comprova a veracidade do evento.

Um ator da aplicação monitorada não é um usuário autenticado do Sentinel. O campo `actor_role` serve apenas como contexto da detecção.

## Matriz de permissões implementada

| Operação | Administrador | Analista | Leitor | Chave de ingestão | Credencial de resposta |
| --- | --- | --- | --- | --- | --- |
| Ler dashboard, eventos, alertas e evidências da organização | Sim | Sim | Sim | Não | Não |
| Alterar estado de alerta | Sim | Sim | Não | Não | Não |
| Criar projetos e gerar/revogar credenciais | Sim | Não | Não | Não | Não |
| Gerenciar membros e configurar regras | Sim | Não | Não | Não | Não |
| Ler auditoria da organização | Sim | Sim | Não | Não | Não |
| Ingerir eventos | Não pela sessão | Não pela sessão | Não | Seu projeto/ambiente | Não |
| Solicitar bloqueio temporário | Sim | Sim | Não | Não | Não |
| Consultar comandos e confirmar resultado | Não pela sessão | Não pela sessão | Não | Não | Seu projeto/ambiente |
| Exportar relatório sanitizado | Sim | Sim | Sim | Não | Não |

Permissões aplicadas na API a toda operação, com escopo e objeto verificados. Ocultar um botão na interface é apenas UX. Acesso a IDs externos ao escopo retorna resposta consistente sem confirmar sua existência. SSE, agregações e exportações seguem as mesmas regras.

## Ameaças e controles

| Ameaça concreta | Controle planejado | Evidência exigida |
| --- | --- | --- |
| Leitor altera um alerta ou analista gera uma chave | Autorização por função e validação de campos alteráveis | Requests diretos falham mesmo sem passar pela UI |
| Usuário acessa evento/alerta de outra organização | Consultas e relações com escopo obrigatório | Testes com duas organizações, IDs conhecidos e SSE |
| Chave exposta no navegador/Git | SDK de servidor, hash de chave aleatória, exibição única e revogação | Bundle sem chave, segredo ausente do histórico e revogação efetiva |
| Replay/reenvio infla alertas | ID único por projeto, comparação de conteúdo e escrita idempotente | Mesmo lote reenviado mantém contagem e alertas |
| Emissor falsifica escopo/papel/IP | Escopo derivado da chave; dados declarados tratados como não confiáveis | Payload não altera organização ou permissões |
| Ingestão excessiva esgota CPU/disco | Limites de payload, lotes, frequência, retenção, backlog e concorrência | Quotas retornam erro e painel segue utilizável |
| Evento injeta HTML, SQL ou quebra logs | Schemas fixos, consultas parametrizadas, texto escapado e logs estruturados | Payloads hostis não executam nem corrompem visualização/log |
| Sessão roubada ou fixada | Token opaco aleatório, hash no banco, rotação, expiração e revogação | Sessão anterior ao login ou revogada deixa de funcionar |
| CSRF altera configuração | Cookie seguro, token CSRF e validação de origem | Request forjada falha; fluxo legítimo passa |
| Worker interrompido perde evento/duplica alerta | Persistência transacional, lease, retry e unicidade | Reinício durante trabalho recupera sem duplicar resultado |
| Credenciais/dados sensíveis entram em logs | Allowlist de campos, redaction e schema de resposta | Fixtures de segredos não aparecem em API, logs ou UI |
| Dependência comprometida ou workflow privilegiado | Lockfiles, análise de dependências, Semgrep e permissões mínimas da CI | Relatórios revisados e workflows sem secrets em PR não confiável |

As prioridades de autorização por objeto/função e consumo de recursos seguem a classificação da [OWASP API Security Top 10](https://api-security.owasp.org/editions/2023/en/0x11-t10/). Esta matriz é uma aplicação ao Sentinel, não uma lista de conformidade completa.

## Credenciais e sessões

- Senhas com Argon2id por biblioteca mantida; parâmetros calibrados e documentados na implementação. Sem criptografia caseira.
- M2: 64 MiB, três iterações e paralelismo um; medição local e limites de login em [AUTHENTICATION.md](AUTHENTICATION.md).
- Chaves de ingestão e tokens de sessão com pelo menos 256 bits aleatórios; guardar hash, prefixo público e metadados. Comparação segura e geração por fonte criptográfica do runtime.
- Cookie de sessão `HttpOnly`, `Secure` em HTTPS, `SameSite=Lax`, sem domínio amplo; escopo de caminho compatível com API e SSE. Exceção HTTP apenas para ambiente local.
- Tempo inicial proposto: expiração por inatividade de 30 minutos e absoluta de 8 horas, com avaliação em cada request. Sessão revogada/expirada encerra SSE.
- Login com resposta genérica para credenciais inválidas e limites por conta/IP. Segredos removidos dos logs de request.
- Criação inicial de administrador por comando local, senha informada de forma interativa e sem inclusão em linha de comando, commit ou seed.
- Permissões e estado de associação consultados no servidor; alterações têm efeito sobre sessões ativas.

Consultar a [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) para detalhar geração, cookies e ciclo de vida da sessão durante a implementação.

## Eventos, privacidade e auditoria

Guardar somente campos necessários à detecção. Não aceitar senhas, tokens, cookies, Authorization, corpos de formulário ou dados pessoais livres em metadata. Evitar email como chave de correlação; preferir ID pseudônimo da aplicação. Renderizar valores como texto e parametrizar consultas.

Retenção implementada na M6: eventos concluídos por 30 dias, alertas resolvidos/evidências após 90 dias de inatividade e auditoria por 90 dias. Fila pendente impede purge do projeto, preservando janelas históricas; falhas e investigações abertas/triadas não expiram automaticamente. Snapshots guardam evento normalizado, horário e ordem, sem corpo livre/headers e independentes do original. API/detector não podem alterar snapshots nem apagar eventos; a API também perdeu UPDATE de eventos/jobs. Comandos privados, simulação, lotes e medição de espaço em [OPERATIONS.md](OPERATIONS.md). Backups têm ciclo próprio; purge online não os remove.

A auditoria registra ator, ação, objeto, instante e mudança sanitizada. Escrita pelo serviço, sem edição/exclusão pela UI. Integridade criptográfica de evidências e armazenamento WORM ficam fora do MVP. Orientações de conteúdo, exclusão de segredos e proteção dos logs: [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).

## Infraestrutura e pipeline

- TLS no deploy; banco e worker em rede privada, sem publicação das portas internas.
- Papéis de banco separados para migrations, API e worker, com permissões necessárias a cada um. Workers não consultam senhas/sessões.
- Validar proxy confiável explicitamente; não aceitar `X-Forwarded-For` de qualquer origem.
- Credenciais locais por ambiente, arquivos ignorados no Git e `.env.example` sem valores reais.
- Headers de segurança e CSP compatíveis com a UI; evitar CORS amplo quando a aplicação usa a mesma origem.
- Health check público mínimo; métricas, fila em falha e logs operacionais restritos à operação.
- Workflows com `contents: read` por padrão, actions fixadas e análise de dependências TypeScript/Python. Não executar código de PR não confiável com secrets de deploy.
- Restaurar backup em ambiente isolado antes de declarar o deploy recuperável.

## Demonstração pública e resposta

Os cenários automatizados ficam restritos ao laboratório local. Caso haja demo pública, ela será de leitura, com dataset fictício isolado, limites e identificação visível de simulação. Sem credenciais administrativas públicas ou ingestão aberta para terceiros.

Na v0.2.0, bloqueio será uma ação explícita com TTL máximo, escopo, motivo e auditoria. Um adaptador autorizado da demo consulta instruções e confirma aplicação. Estado `requested` não significa `applied`; expiração e falha serão visíveis. Evitar bloquear com base apenas no IP da conexão do SDK. NAT, proxies e falsos positivos exigem revisão humana.

## M7 — resposta e exportação implementadas

O segredo de resposta tem 256 bits aleatórios, hash com propósito distinto, exibição única, escopo de projeto/ambiente e revogação. Admin/analyst só solicitam IP presente nas evidências; motivo e TTL são limitados, sem mass assignment de escopo. O adaptador autentica confirmações, não recebe motivos pessoais e não controla o firewall. A aplicação integrada permanece uma fronteira de confiança: uma confirmação não constitui atestação independente. Revogação impede consultas futuras; ações já instaladas expiram pelo relógio local. Somente um processo de demo é suportado.

Versões e revisões são append-only para API/detector; snapshot do job é imutável e definido pelo banco na ingestão, não pelo payload. Alterar limites não reinterpreta a fila ou o histórico. Exportação constrói uma projeção permitida, omite campos livres e troca identidades por rótulos; conserva timestamps e requer revisão antes de compartilhar. Auditoria não recebe segredos, IPs ou motivo livre; identifica ação, versão/código, TTL ou credencial do adaptador conforme aplicável. [Estados, permissões, limites e reprodução](RESPONSE.md).
