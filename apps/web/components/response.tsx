"use client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Alert, ApiError, date, type Event, request } from "../lib/models";
import { Confirm, Empty, ErrorState, Loading } from "./feedback";
import { Button } from "./ui/button";
import { useScope } from "./workspace";

type ResponseAction = {
  id: string;
  sourceIp: string;
  reason: string;
  ttlSeconds: number;
  state: "requested" | "applied" | "failed" | "expired";
  failureCode: string | null;
  requestedAt: string;
  expiresAt: string;
  appliedAt: string | null;
  expiredConfirmedAt: string | null;
};
const names = {
  requested: "Aguardando aplicação",
  applied: "Aplicado",
  failed: "Falhou",
  expired: "Prazo encerrado",
};
const failures: Record<string, string> = {
  capacity: "Capacidade do adaptador atingida",
  unsupported_target: "IP não suportado pelo adaptador",
  adapter_error: "Falha no adaptador",
};
export function ResponsePanel({
  alert,
  evidence,
}: {
  alert: Alert;
  evidence: Event[];
}) {
  const { base, organization, session } = useScope();
  const endpoint = `${base}/alerts/${alert.id}/responses`;
  const actions = useQuery({
    queryKey: [endpoint],
    queryFn: ({ signal }) => request<ResponseAction[]>(endpoint, { signal }),
    refetchInterval: 2000,
  });
  const targets = [
    ...new Set(
      evidence.flatMap((event) =>
        event.payload.source_ip ? [event.payload.source_ip] : [],
      ),
    ),
  ];
  const [target, setTarget] = useState(""),
    [reason, setReason] = useState(""),
    [ttl, setTtl] = useState(300),
    [notice, setNotice] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const sourceIp = targets.includes(target) ? target : (targets[0] ?? "");
  const [requestId, setRequestId] = useState<string | undefined>();
  const valid =
    sourceIp &&
    reason.trim().length >= 10 &&
    /^[\p{L}\p{N} .,:;_()/-]+$/u.test(reason.trim());
  return (
    <section className="response-section" aria-labelledby="response-title">
      <div className="section-heading">
        <h2 id="response-title">Resposta temporária</h2>
        <Button
          variant="outline"
          onClick={() => {
            void actions.refetch();
          }}
        >
          Atualizar respostas
        </Button>
      </div>
      <p>
        O bloqueio vale somente na aplicação conectada a este projeto, no
        ambiente <strong>{alert.environment}</strong>. Confira o IP e o possível
        impacto em usuários que compartilham a mesma conexão.
      </p>
      {organization.role === "reader" ? (
        <p className="muted">
          Somente administradores e analistas podem solicitar bloqueios.
        </p>
      ) : !targets.length ? (
        <p>
          Não há IP nas evidências desta página. Consulte outra página da
          investigação antes de solicitar uma resposta.
        </p>
      ) : (
        <fieldset className="response-fields" disabled={submitting}>
          <legend>Solicitar um bloqueio de 15 segundos a 1 hora</legend>
          <label>
            IP das evidências
            <select
              value={sourceIp}
              onChange={(e) => {
                setTarget(e.target.value);
                setRequestId(undefined);
              }}
            >
              {targets.map((ip) => (
                <option key={ip}>{ip}</option>
              ))}
            </select>
          </label>
          <label>
            Duração
            <select
              value={ttl}
              onChange={(e) => {
                setTtl(Number(e.target.value));
                setRequestId(undefined);
              }}
            >
              <option value={15}>15 segundos</option>
              <option value={60}>1 minuto</option>
              <option value={300}>5 minutos</option>
              <option value={900}>15 minutos</option>
              <option value={3600}>1 hora</option>
            </select>
          </label>
          <label className="response-reason">
            Motivo
            <input
              value={reason}
              minLength={10}
              maxLength={240}
              onChange={(e) => {
                setReason(e.target.value);
                setRequestId(undefined);
              }}
              placeholder="Descreva a decisão sem dados pessoais ou segredos"
            />
          </label>
          {valid ? (
            <Confirm
              key={`${sourceIp}/${ttl}/${reason}`}
              label="Revisar bloqueio"
              prompt={`Bloquear ${sourceIp} em ${alert.environment} por ${ttl} segundos? Motivo: ${reason.trim()}`}
              confirmLabel="Solicitar bloqueio"
              action={async () => {
                setSubmitting(true);
                try {
                  const identifier = requestId ?? crypto.randomUUID();
                  setRequestId(identifier);
                  await request(endpoint, {
                    method: "POST",
                    headers: { "x-csrf-token": session.csrfToken },
                    body: JSON.stringify({
                      requestId: identifier,
                      sourceIp,
                      reason: reason.trim(),
                      ttlSeconds: ttl,
                    }),
                  });
                  setNotice(
                    "Solicitação registrada. Aguarde a confirmação da aplicação abaixo.",
                  );
                  await actions.refetch();
                } finally {
                  setSubmitting(false);
                }
              }}
            />
          ) : (
            <p className="muted">
              Informe um motivo de 10 a 240 caracteres, sem símbolos especiais,
              para revisar o bloqueio.
            </p>
          )}
        </fieldset>
      )}
      <p role="status">{notice}</p>
      {actions.isPending ? (
        <Loading />
      ) : actions.error ? (
        <ErrorState
          error={actions.error}
          retry={() => {
            void actions.refetch();
          }}
        />
      ) : !actions.data?.length ? (
        <Empty title="Nenhuma resposta solicitada">
          <p>As confirmações e falhas da aplicação aparecerão aqui.</p>
        </Empty>
      ) : (
        <div className="response-history">
          {actions.data.map((action) => (
            <article key={action.id}>
              <div className="section-heading">
                <strong>{action.sourceIp}</strong>
                <span className={`response-state ${action.state}`}>
                  {names[action.state]}
                </span>
              </div>
              <p>{action.reason}</p>
              <p className="muted">
                Solicitado em {date(action.requestedAt)} · Prazo:{" "}
                {date(action.expiresAt)}
              </p>
              {action.appliedAt && (
                <p>Aplicação confirmou em {date(action.appliedAt)}.</p>
              )}
              {action.state === "requested" && (
                <p>
                  A aplicação ainda não confirmou. Verifique se o adaptador está
                  conectado.
                </p>
              )}
              {action.state === "failed" && (
                <p>
                  {failures[action.failureCode ?? ""] ??
                    "A aplicação informou uma falha"}
                  .
                </p>
              )}
              {action.state === "expired" && (
                <p>
                  {action.expiredConfirmedAt
                    ? `Remoção confirmada pela aplicação em ${date(action.expiredConfirmedAt)}.`
                    : "O prazo terminou; a aplicação ainda não confirmou a remoção."}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
export function ReportDownload({ alertId }: { alertId: string }) {
  const { base } = useScope();
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="report-section">
      <h2>Compartilhar a investigação</h2>
      <p>
        O relatório substitui atores e IPs por rótulos e omite recursos,
        metadados, credenciais e motivos dos bloqueios. Os horários permanecem;
        revise o arquivo antes de compartilhar.
      </p>
      <Button
        variant="outline"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError("");
          try {
            const response = await fetch(
              `/api${base}/alerts/${alertId}/report`,
              { credentials: "same-origin", cache: "no-store" },
            );
            if (!response.ok) throw new ApiError(response.status);
            const url = URL.createObjectURL(await response.blob()),
              link = document.createElement("a");
            link.href = url;
            link.download = "sentinel-investigation.json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (err) {
            setError(
              err instanceof Error
                ? err.message
                : "Não foi possível gerar o relatório.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Preparando relatório…" : "Baixar relatório sanitizado"}
      </Button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
