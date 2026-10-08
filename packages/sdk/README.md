# SDK de servidor Sentinel

Pacote privado TypeScript/Node.js do monorepo, sem publicação npm. `SentinelClient.track()` enfileira eventos sem aguardar rede; `flush()` e `close()` controlam envio/encerramento; `stats()` torna as perdas e o buffer observáveis.

O SDK mantém UUID/body entre retries, valida recibos e limita buffer, lote, timeout, idade e tentativas. HTTPS fora de loopback; redirects são recusados. A chave deve existir somente no servidor. Buffer em memória não garante entrega antes do aceite da API.

Veja [guia, exemplo de integração e parâmetros](../../docs/INGESTION.md). A [demo](../../apps/demo) exercita login/autorização reais; os testes incluem timeout HTTP, perda de resposta e rejeições.
