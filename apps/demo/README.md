# Aplicação HTTP de laboratório

Demo própria, local e instrumentada: login, verificação de papel e alteração administrativa produzem eventos com o SDK de servidor. As contas e sessões fictícias são independentes do acesso ao Sentinel. Não há UI nesta entrega.

Na raiz, com os serviços e migrations disponíveis:

```sh
pnpm demo:setup
pnpm demo:start
```

Em outro terminal, `pnpm demo:scenario` gera 15 eventos. Consulte [métricas](http://localhost:3002/lab/metrics) e o [guia completo](../../docs/INGESTION.md). `.env.demo` contém credenciais aleatórias, não versionadas. `pnpm test` verifica que a indisponibilidade do Sentinel não impede as decisões de login/autorização; `pnpm test:ingestion` verifica a persistência real.
