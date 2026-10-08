# Referências de design — tela inicial da M1

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
