# Produto e escopo

## Origem

Contexto recuperado da conversa [Ideias Fullstack Cybersec](https://chatgpt.com/c/6ac704e0-7ad4-83e9-8f8e-769b88bde2a7), consultada em 8 de outubro de 2026.

A proposta original descreve o Sentinel como uma central de monitoramento de segurança, semelhante a um mini-SIEM voltado a aplicações web. Um SDK registra tentativas de login, acessos negados e alterações críticas; uma API recebe os eventos; um motor de detecção gera alertas; o dashboard oferece histórico, gráficos e investigação.

A stack sugerida na conversa foi Next.js/TypeScript, Tailwind, shadcn/ui e TanStack Query; Node.js/Fastify, REST, Zod e OpenAPI; Python/FastAPI e workers; PostgreSQL/Drizzle, Redis quando necessário; Docker, GitHub Actions, OWASP e Semgrep.

As decisões específicas dos documentos deste repositório são propostas de planejamento. Limiares, entidades, autenticação e etapas não estavam definidos na conversa original.

## Problema e público

Pequenas equipes que desenvolvem aplicações web precisam entender atividades suspeitas sem montar uma plataforma corporativa de SIEM. Logs separados dificultam perceber repetição, conectar ações de uma conta e explicar por que uma atividade merece investigação.

O primeiro usuário será o desenvolvedor responsável por integrar uma aplicação própria. O analista investigará alertas e registrará decisões. Um leitor poderá acompanhar o estado de segurança sem alterar configurações.

## Resultado esperado

Permitir responder a quatro perguntas: o que aconteceu, em qual aplicação, por que foi considerado suspeito e quais eventos sustentam essa conclusão.

Para o portfólio, a evidência principal será uma demonstração reproduzível com integração real e testes de autorização. O dashboard será alimentado pela API e pelo banco, com indicação explícita de dados de demonstração.

## Escopo P0 — MVP / v0.1.0

| Capacidade | Entrega |
| --- | --- |
| Acesso | Login, logout, sessões revogáveis e três papéis |
| Organização | Isolamento entre organizações, projetos e credenciais |
| Integração | SDK de servidor, geração/revogação de chave e exemplo de uso |
| Ingestão | Lotes pequenos, validação, quotas, deduplicação e fila persistente |
| Detecção | Três regras determinísticas, versionadas e explicáveis |
| Eventos | Listagem paginada, filtros por período/tipo/ator/IP e detalhe |
| Alertas | Severidade, evidências, responsável e estados aberto/em investigação/resolvido/falso positivo |
| Dashboard | Volume, falhas de login, acessos negados, alertas e saúde da ingestão |
| Auditoria | Registro de mudanças de regra, chave, permissões e estado dos alertas |
| Laboratório | Aplicação instrumentada e cenários locais repetíveis |
| Operação | Docker Compose, CI, métricas básicas, retenção e documentação |

Provisionamento inicial de usuários será feito por comando administrativo; cadastro público, recuperação por email e convites serão posteriores. Não haverá credenciais de administrador fixas em imagem, seed ou documentação.

## Escopo P1 — resposta / v0.2.0

- Bloqueio temporário de IP solicitado manualmente e aplicado pela aplicação integrada.
- Histórico e expiração da ação; confirmação do resultado pelo adaptador da aplicação.
- Exportação de relatório de investigação, com redaction de dados sensíveis.
- Configuração de limiares e ativação das regras pelo administrador.
- Métricas de falso positivo e ajustes demonstrados com cenários de teste.

Bloqueio não será anunciado como uma função pronta do MVP. O Sentinel sozinho não modifica firewall, proxy ou rede da aplicação monitorada.

## Escopo P2 — evolução / v1.0.0

- MFA, convites e recuperação de acesso com provedor de email.
- Alertas por integrações externas, com controle de destinos e auditoria.
- SDKs adicionais, regras avançadas e integração com aplicações reais autorizadas.
- Redis caso medições indiquem necessidade de processamento ou rate limiting distribuído.
- FastAPI caso o serviço de análise precise de uma API interna independente.
- Deploy público após validar isolamento, limites, custos e recuperação.

Não fazem parte da primeira versão: exploração de alvos externos, scanner de vulnerabilidades, EDR, captura de tráfego, machine learning, Kubernetes, billing ou promessa de substituição de um SIEM empresarial.

## Cenário de demonstração

1. Subir o ambiente local e criar uma organização, um projeto e uma chave.
2. Integrar a aplicação de exemplo com o SDK e produzir atividade normal.
3. Executar um cenário local de falhas repetidas de login.
4. Ver o alerta surgir com contagem, janela de tempo, regra e eventos relacionados.
5. Investigar a sequência; atribuir responsável e resolver ou marcar falso positivo.
6. Repetir para acessos negados e ações administrativas suspeitas.
7. Mostrar que outro usuário/organização não consegue acessar essas evidências.
8. Na v0.2.0, aplicar bloqueio temporário na aplicação de exemplo e confirmar expiração.

## Experiência e design

Telas previstas: acesso, visão geral, projetos e integração, eventos, alertas, investigação, regras e auditoria. Cada tela terá estados de carregamento, vazio, erro e falta de permissão; gráficos acompanharão valores e descrições textuais.

A direção visual será definida no marco do frontend. Antes de decidir o visual, consultar a skill `frontend-design-references` indicada em [AGENTS.md](../AGENTS.md), ler sua referência complementar e registrar os exemplos realmente utilizados. O planejamento atual define funções, sem escolher paleta, composição ou animações.

## Critério de conclusão

O MVP será concluído quando os três cenários funcionarem do SDK ao dashboard, as evidências forem verificáveis, os testes de isolamento e recuperação passarem e uma pessoa conseguir reproduzir a demonstração seguindo o README. Metas mensuráveis estão em [VALIDATION.md](VALIDATION.md).
