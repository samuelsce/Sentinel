# Aplicação HTTP de laboratório

Demo própria, local e instrumentada: login, verificação de papel e alteração administrativa produzem eventos com o SDK de servidor. As contas e sessões fictícias são independentes do acesso ao Sentinel. Não há UI nesta entrega.

M7: o adaptador consulta comandos com uma credencial de resposta independente, bloqueia o IP nas requisições da demo e confirma aplicação/expiração. O TTL funciona localmente enquanto o Sentinel está indisponível; a restauração precede a abertura da porta. Somente `demo`, um processo, sem firewall ou proxy. [Configuração, atualização de .env.demo existente e reprodução](../../docs/RESPONSE.md).

Na raiz, com os serviços e migrations disponíveis:

```sh
pnpm demo:setup
pnpm demo:start
```

Em outro terminal, `pnpm demo:scenario` gera 22 eventos. Consulte [métricas](http://localhost:3002/lab/metrics), o [guia completo](../../docs/INGESTION.md) e [detecção/investigação](../../docs/DETECTIONS.md). `.env.demo` contém credenciais aleatórias, não versionadas. `pnpm test` verifica que a indisponibilidade do Sentinel não impede as decisões de login/autorização; `pnpm test:ingestion` verifica a persistência real e `pnpm test:detection` confirma as três regras em projeto novo.
