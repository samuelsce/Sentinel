# Dashboard e investigação — M5

M6 acrescenta snapshots preservados após retenção. A timeline e as decisões sinalizam originais/gatilhos expirados; links indisponíveis são retirados, sem perder regra, contagem ou payload normalizado. Métricas privadas e política de limpeza em [OPERATIONS.md](OPERATIONS.md); demonstração dos três cenários em [WALKTHROUGH.md](WALKTHROUGH.md).

O dashboard usa eventos, alertas e evidências reais da API. Não há contagens de exemplo, cadastro público, simulador no navegador ou chave de máquina no bundle. O laboratório é iniciado por comando local: [README](../README.md).

## Acesso e papéis

1. Provisione uma conta pelo comando interativo ou use o operador gerado por `pnpm demo:setup`, lendo somente seu `.env.demo` local.
2. Abra `http://localhost:3000/login`. A sessão fica em cookie HttpOnly; o token CSRF fica em memória. Logout limpa o cache após confirmação da API.
3. Escolha organização/projeto no cabeçalho. IDs na URL preservam o contexto de navegação, mas não concedem acesso: a API revalida vínculo, papel e objeto em cada consulta.
4. Administradores criam projetos, emitem/revogam chaves; analistas e administradores alteram o estado dos alertas; leitores consultam eventos/evidências. Gestão de membros permanece pela API/provisionador.

Integração exibe o segredo somente na resposta de emissão, em memória da tela. Ao ocultar, sair da página ou trocar projeto, o segredo é descartado; GET de chaves retorna somente prefixos. Copiar para clipboard é uma ação explícita. A revogação exige confirmação inline; Escape cancela e devolve foco ao botão. A chave deve ficar no servidor da aplicação monitorada, nunca em URLs, logs ou armazenamento do navegador.

Configure `SENTINEL_ENDPOINT=http://localhost:3001/v1/ingest/events` e a chave no servidor da sua aplicação local. O exemplo usa o SDK privado do monorepo: [instalação e limites](INGESTION.md). Uma chave só aceita seu próprio ambiente. O fluxo demo usa `demo`.

## Consultas e investigação

- **Visão geral:** eventos recebidos nas últimas 24 horas, 24 intervalos reais de uma hora, estados de alertas de todo o histórico e fila pendente/falha. Um comando SQL usa o mesmo snapshot para todas as contagens. Ambiente filtra todos esses dados. O gráfico também oferece uma tabela textual.
- **Eventos:** filtros de ambiente/tipo/período local, recebimento decrescente, páginas de 20 e cursor preservado na URL. Trocar filtro reinicia paginação. Detalhe mostra conteúdo validado, renderizado como texto.
- **Alertas:** filtros de ambiente/regra/estado e páginas de 20. A investigação apresenta regra/versão, correlação, contagem/limiar/janela, decisão inicial/última, gatilho e pico.
- **Evidências:** timeline por recebimento crescente, páginas de 25, papéis de suporte/gatilho/contexto e detalhes expansíveis. Limite de 200 evidências fica explícito. O episódio pode acumular evidências fora da última janela.
- **Triagem:** mudança inclui `expectedVersion`, cookie e CSRF. Em 409, a interface informa a concorrência e consulta o estado atual, sem repetir a escrita automaticamente. Leituras do detalhe também registram auditoria, inclusive reconsultas ao vivo.

Listas são consultas atuais, não snapshots de navegação: nova atividade pode mudar resultados entre páginas. Nenhum alerta não significa ausência de risco. Erros ficam explícitos e oferecem tentativa manual; contagens não são inventadas para preencher a tela.

## Mesma origem e canal ao vivo

O browser chama `/api/v1/...` em Next.js. O proxy tem destino interno fixo (`API_INTERNAL_URL`), métodos/caminhos permitidos, corpo de mutação de até 8 KiB, timeout de 10 s até os headers, `no-store` e redirects bloqueados. Encaminha cookie, Origin, Sec-Fetch-Site e CSRF sem forjar confiança ou IP. Ingestão de máquina não faz parte deste proxy. Headers de frame, tipo e referência também protegem as páginas.

| API no escopo `/v1/organizations/:orgId/projects/:projectId` | Comportamento |
| --- | --- |
| `GET /overview?environment=demo` | Snapshot de contagens, série de 24 horas e `asOf`/`since` |
| `GET /stream` | SSE autenticado para todos os três papéis; mesma origem quando Origin estiver presente |

SSE verifica a cada 2 s o estado persistido e o acesso. `refresh` invalida consultas ativas; `heartbeat` mantém o canal; `access-lost` fecha e reconsulta sessão/vínculos; `unavailable` sinaliza reconexão. As mensagens contêm somente `{}`, sem eventos, evidências, IDs ou credenciais. Mudanças de papel também provocam atualização das permissões visíveis.

A conexão dura no máximo cinco minutos e o browser reconecta automaticamente (retry de 3 s). Toda abertura refaz consultas: SSE não tem log de replay nem usa Last-Event-ID. Offline/reconexão ou retorno à janela recuperam o estado por GET. Se o canal não abrir, a interface tenta recuperar por consultas a cada 10 s e mantém botão Atualizar dados. Janela oculta acumula necessidade de atualização sem refazer consultas. Heartbeats não atualizam `last_seen_at`; sessão expirada, revogada ou vínculo inativo encerram o canal. Consultas interativas seguem o ciclo de sessão da M2.

Limites: três conexões por usuário e 64 por processo, resposta 429/Retry-After, cancelamento propagado pelo proxy e fechamento quando há backpressure. Estes limites não são distribuídos. O polling por conexão executa agregações: carga e estratégia de notificações compartilhadas dependem da medição da M6. Um futuro proxy de produção deve preservar streaming, desativar buffering e configurar timeout compatível.

## Verificar

`pnpm test:live` verifica overview, isolamento, notificações, recuperação, slots, cancelamento, papéis e expiração em PostgreSQL real. `pnpm test:web` inicia serviços isolados e Chromium: demo → SDK → HTTP → worker → UI, paginação, papéis, chaves, triagem, offline, mobile, teclado e erro/retry. Os testes usam `sentinel_test`, credenciais aleatórias em memória e limpeza de fixtures; não use URLs de banco principal. Consulte [M5.md](milestones/M5.md) para resultados e limites efetivamente validados.

## M7 — resposta, regras e exportação

O detalhe do alerta oferece IPs das evidências desta página, motivo e duração; a confirmação informa o alvo/ambiente/prazo. O histórico consulta resultados reais a cada 2 s e permite atualização manual; exibe falhas, prazo e confirmação de remoção separadamente. Leitor consulta o histórico e baixa relatório, sem controles de bloqueio. A integração emite/revoga a credencial de resposta apenas para administrador e não guarda seu segredo no cache de consultas.

Regras acrescenta um destino à navegação, com configuração atual e histórico. Admin revisa a alteração antes de salvar, com versão otimista; leitor/analista consultam. O download de relatório é privado, pseudonimizado e auditado. Proxy admite somente as rotas novas de sessão; o protocolo de máquina continua fora do proxy. [Reprodução, estados e limites](RESPONSE.md), [validação M7](milestones/M7.md).
