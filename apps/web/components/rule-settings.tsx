"use client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { date, type Rule, request } from "../lib/models";
import { Confirm, ErrorState, Loading } from "./feedback";
import { useScope } from "./workspace";

type ConfiguredRule = Rule & { enabled: boolean; createdAt?: string };
function RuleEditor({
  rule,
  saved,
}: {
  rule: ConfiguredRule;
  saved: () => Promise<void>;
}) {
  const { base, organization, session } = useScope();
  const [enabled, setEnabled] = useState(rule.enabled),
    [threshold, setThreshold] = useState(rule.threshold),
    [windowSeconds, setWindowSeconds] = useState(rule.windowSeconds),
    [pending, setPending] = useState(false);
  const valid =
    Number.isInteger(threshold) &&
    threshold >= 2 &&
    threshold <= 100 &&
    Number.isInteger(windowSeconds) &&
    windowSeconds >= 30 &&
    windowSeconds <= 3600;
  const changed =
    enabled !== rule.enabled ||
    threshold !== rule.threshold ||
    windowSeconds !== rule.windowSeconds;
  return (
    <section className="rule-editor">
      <div className="section-heading">
        <h2>{rule.title}</h2>
        <span className="rule-code">
          {rule.code} v{rule.version} · {rule.enabled ? "Ativa" : "Desativada"}
        </span>
      </div>
      <p>
        {rule.code === "ADMIN-001"
          ? "Mudanças de privilégio geram alerta quando a regra está ativa. A contagem e a janela abaixo se aplicam às ações administrativas críticas após falhas de login."
          : "A regra abre um alerta quando a contagem alcança o limite dentro da janela de recebimento."}
      </p>
      {organization.role !== "admin" ? (
        <p>
          Limite: {rule.threshold} eventos · Janela: {rule.windowSeconds}{" "}
          segundos. Somente administradores podem configurar regras.
        </p>
      ) : (
        <fieldset className="response-fields" disabled={pending}>
          <legend>Configuração para novos eventos deste projeto</legend>
          <label>
            Regra ativa
            <select
              value={String(enabled)}
              onChange={(e) => setEnabled(e.target.value === "true")}
            >
              <option value="true">Sim</option>
              <option value="false">Não</option>
            </select>
          </label>
          <label>
            Limite de eventos
            <input
              type="number"
              min={2}
              max={100}
              step={1}
              value={Number.isNaN(threshold) ? "" : threshold}
              onChange={(e) => setThreshold(e.target.valueAsNumber)}
            />
          </label>
          <label>
            Janela em segundos
            <input
              type="number"
              min={30}
              max={3600}
              step={1}
              value={Number.isNaN(windowSeconds) ? "" : windowSeconds}
              onChange={(e) => setWindowSeconds(e.target.valueAsNumber)}
            />
          </label>
          {valid && changed ? (
            <Confirm
              key={`${enabled}/${threshold}/${windowSeconds}`}
              label="Revisar configuração"
              prompt={`${enabled ? "Ativar" : "Desativar"} ${rule.code} com limite ${threshold} e janela de ${windowSeconds} segundos? A alteração cria uma nova versão.`}
              confirmLabel="Salvar nova versão"
              action={async () => {
                setPending(true);
                try {
                  await request(`${base}/rule-settings/${rule.code}`, {
                    method: "PATCH",
                    headers: { "x-csrf-token": session.csrfToken },
                    body: JSON.stringify({
                      expectedVersion: rule.version,
                      enabled,
                      threshold,
                      windowSeconds,
                    }),
                  });
                  await saved();
                } finally {
                  setPending(false);
                }
              }}
            />
          ) : (
            <p className="muted">
              {valid
                ? "Altere um campo para revisar a configuração."
                : "Use limite de 2 a 100 e janela de 30 a 3600 segundos."}
            </p>
          )}
        </fieldset>
      )}
    </section>
  );
}
export function RuleSettingsView() {
  const { base } = useScope();
  const result = useQuery({
    queryKey: [`${base}/rule-settings`],
    queryFn: ({ signal }) =>
      request<{ current: ConfiguredRule[]; history: ConfiguredRule[] }>(
        `${base}/rule-settings`,
        { signal },
      ),
  });
  return (
    <>
      <div className="page-heading">
        <h1>Regras</h1>
        <p>Ajuste os sinais de segurança ao comportamento da aplicação.</p>
      </div>
      <p className="pipeline-note">
        Cada evento guarda a configuração vigente ao ser recebido. Alterações
        não reprocessam a fila nem mudam decisões antigas. Contagens futuras
        podem considerar eventos anteriores dentro da nova janela.
      </p>
      {result.isPending ? (
        <Loading />
      ) : result.error ? (
        <ErrorState
          error={result.error}
          retry={() => {
            void result.refetch();
          }}
        />
      ) : (
        result.data && (
          <>
            {result.data.current.map((rule) => (
              <RuleEditor
                key={`${base}/${rule.code}/${rule.version}`}
                rule={rule}
                saved={async () => {
                  await result.refetch();
                }}
              />
            ))}
            <section className="rule-history">
              <h2>Histórico de configuração</h2>
              <p className="muted">
                Últimas 50 alterações deste projeto. A versão 1 é o padrão
                original.
              </p>
              {!result.data.history.length ? (
                <p>Nenhuma alteração. As três regras usam a versão original.</p>
              ) : (
                <section
                  className="table-scroll"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must scroll wide history tables.
                  tabIndex={0}
                  aria-label="Histórico de regras"
                >
                  <table>
                    <caption className="sr-only">
                      Versões de regras do projeto
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Regra / versão</th>
                        <th scope="col">Estado</th>
                        <th scope="col">Limite</th>
                        <th scope="col">Janela</th>
                        <th scope="col">Salva em</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.data.history.map((rule) => (
                        <tr key={`${rule.code}/${rule.version}`}>
                          <td>
                            {rule.code} v{rule.version}
                          </td>
                          <td>{rule.enabled ? "Ativa" : "Desativada"}</td>
                          <td>{rule.threshold}</td>
                          <td>{rule.windowSeconds} s</td>
                          <td>{date(rule.createdAt ?? "")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
            </section>
          </>
        )
      )}
    </>
  );
}
