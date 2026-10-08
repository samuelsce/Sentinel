export const dynamic = "force-dynamic";

async function checkConnection() {
  try {
    const response = await fetch(
      `${process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3001"}/health/ready`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(3_000),
      },
    );
    return response.ok && (await response.json()).status === "ready";
  } catch {
    return false;
  }
}

export default async function Home() {
  const connected = await checkConnection();
  return (
    <div className="shell">
      <header>
        <a className="brand" href="/">
          Sentinel
          <span aria-hidden="true" className="brand-mark" />
        </a>
        <a href="https://github.com/samuelsce/Sentinel">Projeto no GitHub</a>
      </header>
      <main>
        <div className="intro">
          <p className="milestone">
            Ambiente local · Acesso pela API disponível
          </p>
          <h1>
            Uma visão clara
            <br />
            da segurança do seu app.
          </h1>
          <p className="description">
            O Sentinel conecta eventos, identifica atividades suspeitas e reúne
            as evidências para investigar cada alerta.
          </p>
        </div>
        <section className="connection" aria-labelledby="connection-title">
          <div>
            <h2 id="connection-title">Conexão do ambiente</h2>
            <p className="connection-note">
              Verificação feita ao abrir esta página.
            </p>
          </div>
          <p className={connected ? "status connected" : "status unavailable"}>
            <span aria-hidden="true" />
            {connected ? "Ambiente conectado" : "Conexão indisponível"}
          </p>
          {!connected && (
            <p className="connection-help">
              Confira as instruções de execução no README e atualize a página
              após iniciar os serviços.
            </p>
          )}
        </section>
        <section className="next-step" aria-labelledby="next-title">
          <h2 id="next-title">O próximo passo</h2>
          <p className="next-description">
            O acesso pela API já está disponível. A próxima entrega conecta
            aplicações para receber eventos; a interface de acesso e a
            investigação de alertas serão adicionadas com o dashboard.
          </p>
          <a href="https://github.com/samuelsce/Sentinel/blob/main/docs/ROADMAP.md">
            Acompanhar o desenvolvimento
          </a>
        </section>
      </main>
      <footer>
        <p className="footer-note">Fullstack, AppSec e Blue Team.</p>
        <p className="footer-note">
          Projeto em desenvolvimento. Monitoramento ainda não disponível.
        </p>
      </footer>
    </div>
  );
}
