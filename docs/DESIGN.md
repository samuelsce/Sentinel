# Referências de design — M1 e M5

Pesquisa em 8 de outubro de 2026, seguindo a skill `frontend-design-references` e a referência complementar `frontend-design` indicadas em AGENTS.md.

## Escopo

A M1 precisa de uma tela mínima que descreva o projeto e confirme a conexão real com a API/banco. Ela não antecipa o dashboard, não simula contagem de ameaças e não oferece ações ainda não implementadas. O usuário desta tela é a pessoa que inicia o ambiente para conhecer o projeto.

## Referência efetivamente aplicada

[UseLayouts — Save Button / Status Button](https://uselayouts.com/docs/components/save-button): catálogo, preview e estados de espera/conclusão inspecionados no navegador. A adaptação aproveita feedback com texto explícito e marcador visual. No Sentinel, o estado vem de uma consulta real de readiness; não usa o tempo de animação para indicar sucesso. Código, assets e efeitos da biblioteca não foram copiados.

[Introdução do UseLayouts](https://uselayouts.com/docs) reforça o uso de interação como feedback de uma ação. A tela inicial não precisa de motion; a consulta ocorre ao carregar e o texto informa quando foi verificada.

Arc UI também foi consultado para avaliar o catálogo, mas seus componentes não influenciaram esta tela. Não há dependência adicionada dessas bibliotecas.

## Direção aplicada

Paleta: superfície `#f7f9fc`, texto `#182b45`, texto secundário `#52647a`, borda `#d8e0ea`, links `#205cc6` e conexão pronta `#176b51`. Status indisponível usa `#8a3b20`, sempre acompanhado de texto.

Tipografia: Segoe UI, com alternativas locais Helvetica Neue/Arial, evitando download de fontes no bootstrap. Título com escala responsiva; parágrafos curtos e alinhados à esquerda.

Layout: uma coluna de conteúdo, header com identidade e GitHub, descrição do Sentinel, linha de status e próximo passo. O status tem duas áreas no desktop e quebra no mobile. Divisores separam conteúdo, sem preencher a tela com cards ou gráficos sem dados.

```text
Sentinel                              Projeto no GitHub

Proposta do projeto
Descrição breve

Conexão do ambiente                   Estado real

Próximo passo
Roadmap
```

Na revisão do plano, removemos a ideia de dashboard com métricas de exemplo: não ajudaria a verificar a M1 e poderia sugerir detecção pronta. A identidade completa e os fluxos operacionais serão definidos na M5; esta referência poderá ser reutilizada para estados de feedback pertinentes.

## Verificação

Conferir renderização em desktop/mobile, texto de conexão pronta/indisponível, navegação por teclado, foco visível e ausência de overflow. Evidências finais serão registradas em [M1.md](milestones/M1.md). Não há animação nesta entrega.

## M5 — pesquisa e direção do dashboard

Pesquisa em 8 de outubro de 2026, antes da implementação, seguindo a mesma skill e sua complementar. O público é o operador de uma aplicação e a pessoa que avalia o portfólio: deve conseguir ir de uma contagem a um evento que explica a decisão. A identidade clara/azul da M1 permanece.

Referências efetivamente usadas:

- [Kobra — Table](https://kobra.systems/components/table): preview renderizado inspecionado. Adaptados alinhamento de colunas, linhas compactas e divisores discretos para eventos/alertas reais. No Sentinel, tabelas são HTML semântico, com caption, links de detalhe, filtros e scroll por teclado. Nenhum código Kobra foi copiado.
- [Arc UI — Confirm Morph](https://uiarc.dev/components/confirm-morph): componente aberto no navegador e confirmação/cancelamento inspecionados por interação. Adaptada confirmação no local da ação para revogar uma chave, com foco inicial em Cancelar, Escape, pendência e erro. Sem copiar animação/código, sem sugerir desfazer uma revogação irreversível.

Navbar Gallery também foi consultada, mas os exemplos de marketing não determinaram o workspace. Não há dependências dessas galerias. O [Button oficial shadcn/ui](https://ui.shadcn.com/docs/components/radix/button) foi adaptado do registro new-york, com MIT preservada em `apps/web/components/ui/LICENSE.shadcn.txt`; estilos usam [Tailwind](https://tailwindcss.com/docs/installation/framework-guides/nextjs). Consultas usam [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview).

### Plano e revisão antes do código

Layout: sidebar de 216 px para quatro destinos; seletores de contexto acima do conteúdo; resumo em faixa com quatro contagens; série temporal e tabela de investigações; no detalhe, rationale à esquerda, triagem à direita e eixo vertical de evidências abaixo. Sem cards idênticos para cada informação. A assinatura visual é a timeline com gatilho destacado, que ajuda a explicar a detecção.

```text
Sentinel     Organização / Projeto                       Papel
Visão geral  Conexão ao vivo                      Atualizar dados
Alertas      Título + filtro
Eventos      Eventos 24h | Abertos | Em análise | Resolvidos
Integração   Atividade real por intervalo
             Investigações recentes: tabela e links

Detalhe      Por que gerou alerta              Estado + ação
             | horário — suporte / gatilho / contexto
             | detalhes expansíveis de cada evento
```

Tipografia: Segoe UI/Helvetica Neue/Arial locais, títulos curtos e tabulação numérica. Tokens herdados: papel `#f7f9fc`, tinta `#182b45`, secundário `#52647a`, divisores `#d8e0ea`, azul `#205cc6`, conexão `#176b51`; estados acrescentam tons sem substituir seus rótulos. Espaçamento cresce entre seções e permanece compacto nas linhas. Ícones Lucide têm texto nas ações; decorativos ficam fora da árvore acessível.

A revisão do plano preservou a identidade existente, rejeitou métricas fictícias e manteve o gráfico vinculado ao snapshot da API. A confirmação depende da resposta real do servidor. Motion é limitado ao feedback das bibliotecas, com override de reduced-motion; não há animação contínua. Campos, mensagens e permissões descrevem ações disponíveis, sem detalhes internos desnecessários ao usuário.

### Inspeção do resultado

M6 reutiliza esta pesquisa e o sistema visual existente, conforme `frontend-design-references`: [Kobra Table](https://kobra.systems/components/table) para densidade/legibilidade e [Arc Confirm](https://uiarc.dev/components/confirm-morph) nos fluxos herdados. Não há redesign. A expiração substitui links quebrados por texto explicativo dentro da mesma hierarquia; screenshots e teste de retenção em [WALKTHROUGH.md](WALKTHROUGH.md).

Chromium em 1440 × 1000 e 390 × 844: overview, tabelas e investigação inspecionados, foco/Escape, skip link, filtros, scroll e preferência reduced-motion exercitados. Screenshots usam somente fixtures fictícias e ocultam identificadores aleatórios de conta. [Overview](assets/m5-overview.png), [investigação](assets/m5-investigation.png), [mobile](assets/m5-mobile.png) e [investigação mobile](assets/m5-mobile-investigation.png). Resultados dos fluxos constam no [relatório da M5](milestones/M5.md).
