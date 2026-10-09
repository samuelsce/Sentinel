"use client";
import { useQuery } from "@tanstack/react-query";
import { Cable, Check, Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import {
  date,
  environments,
  type Key,
  type Overview,
  request,
} from "../lib/models";
import { Confirm, Empty, ErrorState, Loading } from "./feedback";
import { ResponseConnection } from "./response-connection";
import { Button } from "./ui/button";
import { useScope } from "./workspace";

export function IntegrationView() {
  const { base, organization } = useScope();
  return <IntegrationPanel key={`${base}/${organization.role}`} />;
}
function IntegrationPanel() {
  const { base, project, organization, session, refresh } = useScope();
  const [environment, setEnvironment] = useState("demo"),
    [oneTimeKey, setOneTimeKey] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const keys = useQuery({
    queryKey: [`${base}/keys`],
    queryFn: ({ signal }) => request<Key[]>(`${base}/keys`, { signal }),
    enabled: organization.role === "admin",
    gcTime: 0,
  });
  const overview = useQuery({
    queryKey: [`${base}/overview`],
    queryFn: ({ signal }) => request<Overview>(`${base}/overview`, { signal }),
  });
  return (
    <>
      <div className="page-heading">
        <h1>Integração</h1>
        <p>Conecte {project.name} e confirme o primeiro evento recebido.</p>
      </div>
      <ol className="integration-steps">
        <li>
          <KeyRound aria-hidden="true" />
          <div>
            <h2>Crie uma chave de ingestão</h2>
            <p>
              Uma chave permite enviar eventos para este projeto e um ambiente
              específico. Guarde-a somente no servidor da aplicação.
            </p>
            {organization.role === "admin" ? (
              <form
                className="inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setPending(true);
                  setError("");
                  setOneTimeKey("");
                  setNotice("");
                  try {
                    const issued = await request<{ key: string }>(
                      `${base}/keys`,
                      {
                        method: "POST",
                        headers: { "x-csrf-token": session.csrfToken },
                        body: JSON.stringify({ environment }),
                      },
                    );
                    setOneTimeKey(issued.key);
                    await keys.refetch();
                  } catch (err) {
                    setError(
                      err instanceof Error ? err.message : "Tente novamente.",
                    );
                  } finally {
                    setPending(false);
                  }
                }}
              >
                <label>
                  Ambiente da nova chave
                  <select
                    value={environment}
                    onChange={(e) => setEnvironment(e.target.value)}
                  >
                    {environments.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <Button type="submit" disabled={pending}>
                  {pending ? "Gerando…" : "Gerar chave"}
                </Button>
              </form>
            ) : (
              <p className="feedback">
                Peça uma chave ao administrador. Seu papel não permite criar ou
                revogar credenciais.
              </p>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            {oneTimeKey && (
              <section
                className="one-time-key"
                aria-label="Chave exibida uma única vez"
              >
                <h3>Copie agora. Esta chave não será exibida novamente.</h3>
                <p>
                  Ao sair desta tela ou ocultar a chave, só o prefixo ficará
                  disponível.
                </p>
                <label>
                  Chave de ingestão
                  <textarea
                    readOnly
                    autoComplete="off"
                    spellCheck={false}
                    value={oneTimeKey}
                  />
                </label>
                <div className="button-row">
                  <Button
                    variant="outline"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(oneTimeKey);
                        setNotice("Chave copiada.");
                      } catch {
                        setNotice(
                          "Não foi possível copiar. Selecione e copie o texto da chave.",
                        );
                      }
                    }}
                  >
                    <Copy aria-hidden="true" />
                    Copiar chave
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setOneTimeKey("");
                      setNotice("Chave ocultada.");
                    }}
                  >
                    Ocultar chave
                  </Button>
                </div>
              </section>
            )}
            <p role="status" className="success-message">
              {notice}
            </p>
          </div>
        </li>
        <li>
          <Cable aria-hidden="true" />
          <div>
            <h2>Instrumente sua aplicação</h2>
            <p>
              Use o SDK Node.js do monorepo. Ele preserva IDs durante retries e
              limita seu buffer. Chaves não devem entrar no navegador, em URLs
              ou logs.
            </p>
            <pre className="code-example">
              <code>{`import { SentinelClient } from "@sentinel/sdk";

const sentinel = new SentinelClient({
  endpoint: requireEnv("SENTINEL_ENDPOINT"),
  ingestionKey: requireEnv("SENTINEL_INGESTION_KEY"),
  environment: "${environment}",
});

// Registre após a decisão real da aplicação.
sentinel.track({
  type: "auth.login_failed",
  action: "log_in",
  outcome: "failure",
  actor_id: "id-interno-do-usuario",
  metadata: { reason: "invalid_credentials" },
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("Configure " + name);
  return value;
}`}</code>
            </pre>
            <p className="muted">
              O pacote ainda é privado do monorepo.{" "}
              <a href="https://github.com/samuelsce/Sentinel/blob/main/docs/INGESTION.md">
                Leia o guia de instalação e limites do SDK
              </a>
              .
            </p>
          </div>
        </li>
        <li>
          <Check aria-hidden="true" />
          <div>
            <h2>Confirme o recebimento</h2>
            {overview.isPending ? (
              <Loading />
            ) : overview.error ? (
              <ErrorState
                error={overview.error}
                retry={() => {
                  void overview.refetch();
                }}
              />
            ) : overview.data?.lastReceivedAt ? (
              <p className="integration-received">
                Último evento recebido em{" "}
                <strong>{date(overview.data.lastReceivedAt)}</strong>. Consulte
                Eventos e acompanhe o processamento na visão geral.
              </p>
            ) : (
              <p>
                Nenhum evento recebido ainda. Confira o endpoint, a chave e o
                ambiente da aplicação.
              </p>
            )}
            <Button
              variant="outline"
              onClick={() => {
                void refresh();
              }}
            >
              Conferir recebimento
            </Button>
          </div>
        </li>
      </ol>
      <ResponseConnection key={base} />
      {organization.role === "admin" && (
        <section className="panel">
          <div className="section-heading">
            <h2>Chaves deste projeto</h2>
            <span className="muted">Segredos não são recuperáveis</span>
          </div>
          {keys.isPending ? (
            <Loading />
          ) : keys.error ? (
            <ErrorState
              error={keys.error}
              retry={() => {
                void keys.refetch();
              }}
            />
          ) : keys.data?.length ? (
            <section
              className="table-scroll"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must scroll wide tables.
              tabIndex={0}
              aria-label="Tabela de chaves"
            >
              <table>
                <caption className="sr-only">
                  Chaves de ingestão deste projeto
                </caption>
                <thead>
                  <tr>
                    <th>Prefixo</th>
                    <th>Ambiente</th>
                    <th>Criada em</th>
                    <th>Estado / ação</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.data.map((key) => (
                    <tr key={key.id}>
                      <td className="break-value">{key.prefix}</td>
                      <td>{key.environment}</td>
                      <td>{date(key.createdAt)}</td>
                      <td>
                        {key.revokedAt ? (
                          "Revogada"
                        ) : (
                          <Confirm
                            label="Revogar chave"
                            prompt="Revogar esta chave interrompe novos envios com ela."
                            confirmLabel="Revogar"
                            action={async () => {
                              await request(`${base}/keys/${key.id}`, {
                                method: "DELETE",
                                headers: { "x-csrf-token": session.csrfToken },
                              });
                              setOneTimeKey("");
                              setNotice(
                                "Chave revogada. Novos envios com ela serão recusados.",
                              );
                              await keys.refetch();
                            }}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : (
            <Empty title="Nenhuma chave emitida">
              <p>Gere uma chave para começar a enviar eventos.</p>
            </Empty>
          )}
        </section>
      )}
    </>
  );
}
