# Plano de validação

As entregas M1–M5 verificaram ambiente, contratos, identidade, ingestão, detecção e interface; seus relatórios permanecem em `milestones/`. A [M6](milestones/M6.md) acrescenta oito cenários operacionais/de abuso, nove jornadas Chromium, snapshots/retenção, Semgrep/auditorias e medição do laboratório. A matriz abaixo referencia critérios do MVP; metas experimentais são medidas separadamente, sem esconder falhas de capacidade. Resultados e limitações são registrados por versão/ambiente.

## Critérios de aceite do MVP

| ID | Critério | Verificação |
| --- | --- | --- |
| V01 | Integração real da demo até o dashboard | SDK → API → banco → worker → alerta → UI, nos três cenários |
| V02 | Decisões explicáveis | Regra/versão, janela, contagem, limiar e evidências exibidos |
| V03 | Eventos comuns não disparam as regras de teste | Cenário benigno e limites imediatamente abaixo do gatilho |
| V04 | Retry não infla contagens nem duplica alertas | Reenvio de lote/ID e reinício após escrita parcial |
| V05 | Escopo e papéis respeitados | Dois tenants, três papéis, chaves revogadas e acesso direto a IDs externos |
| V06 | Sessões têm ciclo de vida seguro | Login, logout, expiração, rotação, CSRF e revogação durante SSE |
| V07 | UI usa dados persistidos e recupera conexão | Recarregar, desligar SSE, reconectar e confirmar estado pela API |
| V08 | Fila sobrevive a falhas | Encerrar worker após claim, expirar lease e retomar; poison job é inspecionável |
| V09 | Dados sensíveis não vazam | Requests, logs, respostas, evidências, fixtures e bundle revisados |
| V10 | Ambiente é reproduzível | Clone limpo, setup documentado, migrations, bootstrap e cenários |
| V11 | CI verifica os riscos relevantes | Testes, análise estática e de dependências, com achados registrados |
| V12 | Retenção funciona sem apagar evidências vigentes | Envelhecer fixtures, executar limpeza e conferir investigação |

## Estratégia de testes

- **Regras Python:** relógio determinístico, limiares, janelas, silêncio entre episódios, atores ausentes, correlações separadas e duplicados. Sem sleeps reais para testar tempo.
- **API e banco reais:** ingestão/transação, contrato, quotas, permissões, CSRF, relações entre tenants e cursores. Não substituir PostgreSQL por mock nos testes de persistência.
- **Compatibilidade:** as mesmas fixtures JSON passam/falham em Node.js e Python; mudanças de schema são detectadas na CI.
- **SDK:** fila limitada, timeout, retry de erro recuperável/429, identidade preservada e falha do coletor sem derrubar request do app.
- **Ponta a ponta:** Playwright com demo, API e worker; três cenários, investigação e mudanças de estado com auditoria.
- **Abuso:** chave inválida/revogada, IDs externos, timestamp inválido, lote grande, payload XSS, tentativa de mass assignment e consultas excessivas.
- **Falhas de operação:** banco fora do ar antes do commit, worker interrompido, lease vencido, job inválido, backlog e desconexão SSE.
- **UI:** teclado, foco, contraste, leitura dos gráficos, mobile e estados vazio/erro. Ajustar movimento a `prefers-reduced-motion` quando houver animação.

## Metas de laboratório propostas

Medir após implementar a primeira fatia funcional; são metas iniciais, não promessas já verificadas. Registrar hardware, versões, lote, quantidade de dados e resultados p50/p95.

| Medida | Meta inicial e contexto |
| --- | --- |
| Tempo até o alerta visível | p95 ≤ 5 s após aceite do evento que cruza o limiar, com worker ativo e sem backlog |
| Ingestão | p95 ≤ 300 ms para lotes de até 100 eventos em ambiente local, excluindo detecção |
| Carga sustentada | 50 eventos/s por 10 min; contagem persistida corresponde aos IDs únicos confirmados |
| Consulta de eventos | p95 ≤ 500 ms para página de 50 eventos em dataset de 100 mil registros |
| Recuperação | Evento aceito não perdido após reinício do worker; drenagem/latência registrada |

Se as metas falharem, documentar gargalo e medição antes de acrescentar Redis ou outro serviço. Falhas não justificam esconder resultados do portfólio.

## Pacote de evidências do portfólio

Para cada cenário, publicar comando local reproduzível, eventos de entrada fictícios, regra/versão, resultado esperado/observado e screenshot do alerta com a timeline. Mostrar também um caso benigno e uma limitação ou falso positivo.

No README final: diagrama, setup, script de demonstração, testes relevantes, screenshots, vídeo curto quando disponível e decisões técnicas. O walkthrough deve mostrar integração e investigação, sem depender somente de telas pré-preenchidas.

## Gate de deploy

Antes de publicar: testes de isolamento/CSRF, ingestão limitada, dados fictícios da demo separados, secrets configurados, TLS, banco privado, readiness, backups e ensaio de restauração. Escolher provedor e orçamento no roadmap. Nenhum deploy foi realizado nesta etapa.

## M7 — resultados

`pnpm test:response` valida 18 cenários no PostgreSQL com papéis restritos, incluindo bloqueio HTTP na demo, TTL offline, retomada, sobreposição, falhas, revogação e restauração no limite de 100 ações ativas com backlog de expirações. Verifica configuração administrativa, fila com versão congelada, isolamento, sanitização, auditoria e retenção. `pnpm test:web` contém 11 jornadas totais: acrescenta confirmação/estados/download e edição/conflito/histórico/papéis. [Resultados, capturas e limites](milestones/M7.md). Taxa de falsos positivos em produção e carga da M7 não foram medidas.
