"use client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { date, environments, type Key, request } from "../lib/models";
import { Confirm, ErrorState, Loading } from "./feedback";
import { Button } from "./ui/button";
import { useScope } from "./workspace";

export function ResponseConnection() {
  const { base, organization, session } = useScope();
  const keys = useQuery({
    queryKey: [`${base}/response-keys`],
    queryFn: ({ signal }) =>
      request<Omit<Key, "prefix">[]>(`${base}/response-keys`, { signal }),
    enabled: organization.role === "admin",
    gcTime: 0,
  });
  const [environment, setEnvironment] = useState("demo"),
    [oneTimeKey, setOneTimeKey] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="response-section">
      <h2>Adaptador de resposta</h2>
      <p>
        Uma credencial de resposta permite que a aplicação consulte os bloqueios
        deste projeto e ambiente e confirme o resultado. A chave de ingestão não
        tem essa permissão. Há um adaptador pronto para a demo HTTP.
      </p>
      {organization.role !== "admin" ? (
        <p>Peça a um administrador para conectar o adaptador.</p>
      ) : (
        <>
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setPending(true);
              setError("");
              setOneTimeKey("");
              try {
                const result = await request<{ key: string }>(
                  `${base}/response-keys`,
                  {
                    method: "POST",
                    headers: { "x-csrf-token": session.csrfToken },
                    body: JSON.stringify({ environment }),
                  },
                );
                setOneTimeKey(result.key);
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
              Ambiente de resposta
              <select
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
              >
                {environments.map((env) => (
                  <option key={env}>{env}</option>
                ))}
              </select>
            </label>
            <Button
              type="submit"
              disabled={
                pending ||
                keys.isPending ||
                Boolean(
                  keys.data?.some(
                    (key) => key.environment === environment && !key.revokedAt,
                  ),
                )
              }
            >
              {pending ? "Criando…" : "Criar credencial de resposta"}
            </Button>
          </form>
          {oneTimeKey && (
            <div className="one-time-key">
              <p>
                Copie agora para DEMO_RESPONSE_KEY no servidor da demo. Esta
                credencial não será exibida novamente.
              </p>
              <code className="break-value">{oneTimeKey}</code>
              <Button variant="outline" onClick={() => setOneTimeKey("")}>
                Ocultar credencial
              </Button>
            </div>
          )}
          <p className="muted">
            Na demo, configure DEMO_RESPONSE_ENDPOINT com a URL da API seguida
            de /v1/response e reinicie a aplicação. Somente o ambiente demo é
            aceito pelo adaptador fornecido.
          </p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {keys.isPending ? (
            <Loading />
          ) : keys.error ? (
            <ErrorState
              error={keys.error}
              retry={() => {
                void keys.refetch();
              }}
            />
          ) : (
            <ul className="response-key-list">
              {keys.data?.map((key) => (
                <li key={key.id}>
                  <span>
                    {key.environment} · Criada em {date(key.createdAt)} ·{" "}
                    {key.revokedAt ? "Revogada" : "Ativa"}
                  </span>
                  {!key.revokedAt && (
                    <Confirm
                      label="Revogar resposta"
                      prompt={`Revogar a credencial de ${key.environment}? Novas consultas e confirmações serão recusadas. Bloqueios já aplicados permanecem até seu prazo.`}
                      confirmLabel="Revogar credencial de resposta"
                      action={async () => {
                        await request(`${base}/response-keys/${key.id}`, {
                          method: "DELETE",
                          headers: { "x-csrf-token": session.csrfToken },
                        });
                        setOneTimeKey("");
                        await keys.refetch();
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
