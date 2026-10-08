"use client";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  type Alert,
  date,
  type Event,
  environments,
  eventNames,
  type Overview,
  type Page,
  type Rule,
  request,
  ruleNames,
  statusNames,
} from "../lib/models";
import { Empty, ErrorState, Loading } from "./feedback";
import { Button } from "./ui/button";
import { useScope } from "./workspace";

function useData<T>(endpoint: string) {
  return useQuery({
    queryKey: [endpoint],
    queryFn: ({ signal }) => request<T>(endpoint, { signal }),
  });
}
export function Badge({ alert }: { alert: Alert }) {
  return (
    <span className={`badge ${alert.status}`}>
      <span aria-hidden="true" />
      {statusNames[alert.status]}
    </span>
  );
}
function Severity({ severity }: { severity: Alert["severity"] }) {
  return (
    <span className={`severity ${severity}`}>
      <ShieldAlert aria-hidden="true" />
      {severity === "high" ? "Alta" : "Média"}
    </span>
  );
}
function Title({ title, description }: { title: string; description: string }) {
  return (
    <div className="page-heading">
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
function AlertTable({ items }: { items: Alert[] }) {
  const { href } = useScope();
  return (
    <section
      className="table-scroll"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must scroll wide tables.
      tabIndex={0}
      aria-label="Tabela de alertas"
    >
      <table>
        <caption className="sr-only">Alertas persistidos do projeto</caption>
        <thead>
          <tr>
            <th scope="col">Alerta</th>
            <th scope="col">Correlação</th>
            <th scope="col">Severidade</th>
            <th scope="col">Estado</th>
            <th scope="col">Criado em</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td>
                <Link className="row-link" href={href(`/alerts/${a.id}`)}>
                  {ruleNames[a.ruleCode] ?? a.ruleCode}
                </Link>
                <small>
                  {a.ruleCode} v{a.ruleVersion} · {a.environment}
                </small>
              </td>
              <td className="break-value">
                {a.correlation.value}
                <small>
                  {a.correlation.kind === "ip" ? "Endereço IP" : "Ator"}
                </small>
              </td>
              <td>
                <Severity severity={a.severity} />
              </td>
              <td>
                <Badge alert={a} />
              </td>
              <td className="date-cell">{date(a.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
function EventTable({ items }: { items: Event[] }) {
  const { href } = useScope();
  return (
    <section
      className="table-scroll"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must scroll wide tables.
      tabIndex={0}
      aria-label="Tabela de eventos"
    >
      <table>
        <caption className="sr-only">Eventos recebidos do projeto</caption>
        <thead>
          <tr>
            <th scope="col">Evento</th>
            <th scope="col">Ator / origem</th>
            <th scope="col">Ambiente</th>
            <th scope="col">Recebido em</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td>
                <Link className="row-link" href={href(`/events/${e.id}`)}>
                  {eventNames[e.payload.type] ?? e.payload.type}
                </Link>
                <small>{e.payload.action}</small>
              </td>
              <td className="break-value">
                {e.payload.actor_id ?? "Ator não informado"}
                <small>{e.payload.source_ip ?? "IP não informado"}</small>
              </td>
              <td>{e.payload.environment}</td>
              <td className="date-cell">{date(e.receivedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
function EnvironmentFilter({
  value,
  change,
}: {
  value: string;
  change: (value: string) => void;
}) {
  return (
    <label>
      Ambiente
      <select value={value} onChange={(e) => change(e.target.value)}>
        <option value="">Todos os ambientes</option>
        {environments.map((e) => (
          <option key={e}>{e}</option>
        ))}
      </select>
    </label>
  );
}
export function OverviewView() {
  const { base, href, project } = useScope(),
    [environment, setEnvironment] = useState("");
  const summary = useData<Overview>(
    `${base}/overview${environment ? `?environment=${environment}` : ""}`,
  );
  const recent = useData<Page<Alert>>(
    `${base}/alerts?limit=5${environment ? `&environment=${environment}` : ""}`,
  );
  const rules = useData<Rule[]>(`${base}/rules`);
  const max = Math.max(
    1,
    ...(summary.data?.activity.map((b) => b.count) ?? []),
  );
  return (
    <>
      <Title
        title="Visão geral"
        description={`Acompanhe os sinais de segurança de ${project.name}.`}
      />
      <div className="filter-bar">
        <EnvironmentFilter value={environment} change={setEnvironment} />
      </div>
      {summary.isPending ? (
        <Loading />
      ) : summary.error ? (
        <ErrorState
          error={summary.error}
          retry={() => {
            void summary.refetch();
          }}
        />
      ) : (
        summary.data && (
          <>
            <dl className="summary-strip">
              <div>
                <dt>Eventos nas últimas 24 h</dt>
                <dd data-testid="events-count">
                  {summary.data.events24h.toLocaleString("pt-BR")}
                </dd>
              </div>
              <div>
                <dt>Alertas abertos</dt>
                <dd data-testid="open-alerts-count">
                  {summary.data.openAlerts}
                </dd>
              </div>
              <div>
                <dt>Em análise</dt>
                <dd>{summary.data.triagedAlerts}</dd>
              </div>
              <div>
                <dt>Resolvidos</dt>
                <dd>{summary.data.resolvedAlerts}</dd>
              </div>
            </dl>
            <section className="activity-section">
              <div className="section-heading">
                <h2>Atividade recebida</h2>
                <span className="muted">Últimas 24 horas</span>
              </div>
              <figure className="activity-chart">
                <figcaption className="sr-only">
                  {summary.data.events24h} eventos recebidos, agrupados em 24
                  intervalos de uma hora.
                </figcaption>
                <div className="bars" aria-hidden="true">
                  {summary.data.activity.map((b) => (
                    <div
                      key={b.hour}
                      title={`${date(b.hour)}: ${b.count} eventos`}
                    >
                      <span
                        style={{
                          height: `${(b.count / max) * 100}%`,
                          minHeight: b.count ? "3px" : 0,
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="chart-axis" aria-hidden="true">
                  <span>{date(summary.data.since)}</span>
                  <span>{date(summary.data.asOf)}</span>
                </div>
              </figure>
              <details className="chart-data">
                <summary>Ver contagens por hora</summary>
                <table>
                  <caption>Atividade por intervalo de uma hora</caption>
                  <thead>
                    <tr>
                      <th>Início</th>
                      <th>Eventos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.data.activity.map((b) => (
                      <tr key={b.hour}>
                        <td>{date(b.hour)}</td>
                        <td>{b.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
              <p className="pipeline-note">
                {summary.data.pendingJobs > 0
                  ? `${summary.data.pendingJobs} eventos aguardam processamento.`
                  : "Nenhum evento aguarda processamento."}{" "}
                {summary.data.failedJobs > 0 &&
                  `${summary.data.failedJobs} jobs falharam; peça ao administrador para conferir o diagnóstico da fila.`}{" "}
                Última consulta: {date(summary.data.asOf)}.
              </p>
            </section>
          </>
        )
      )}
      <section className="panel recent-alerts">
        <div className="section-heading">
          <h2>Investigações recentes</h2>
          <Link href={href("/alerts")}>Ver todos os alertas</Link>
        </div>
        {recent.isPending ? (
          <Loading />
        ) : recent.error ? (
          <ErrorState
            error={recent.error}
            retry={() => {
              void recent.refetch();
            }}
          />
        ) : recent.data?.items.length ? (
          <AlertTable items={recent.data.items} />
        ) : (
          <Empty title="Nenhum alerta recebido">
            <p>
              Os alertas aparecem quando os eventos satisfazem uma regra. Sem
              alertas não significa ausência de risco.
            </p>
            <Link href={href("/integration")}>Conectar uma aplicação</Link>
          </Empty>
        )}
      </section>
      <section className="rules-section">
        <h2>O que o Sentinel observa</h2>
        <p className="muted">
          Regras determinísticas do laboratório. Cada decisão pode ser
          investigada.
        </p>
        {rules.error ? (
          <ErrorState
            error={rules.error}
            retry={() => {
              void rules.refetch();
            }}
          />
        ) : (
          <ul className="rule-list">
            {rules.data?.map((r) => (
              <li key={`${r.code}/${r.version}`}>
                <span className="rule-code">
                  {r.code} v{r.version}
                </span>
                <strong>{r.title}</strong>
                <span>
                  {r.code === "ADMIN-001"
                    ? `Mudança de privilégio ou ação crítica após ${r.threshold} falhas em ${r.windowSeconds / 60} min.`
                    : `${r.threshold} eventos em ${r.windowSeconds / 60} min.`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function ListView({ kind }: { kind: "events" | "alerts" }) {
  const { base, href } = useScope(),
    router = useRouter(),
    params = useSearchParams();
  const search = new URLSearchParams();
  search.set("limit", "20");
  for (const name of kind === "events"
    ? ["environment", "type", "from", "to", "cursor"]
    : ["environment", "ruleCode", "status", "cursor"]) {
    const value = params.get(name);
    if (value) search.set(name, value);
  }
  const result = useData<Page<Event | Alert>>(`${base}/${kind}?${search}`);
  const change = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    next.delete("cursor");
    if (value) next.set(name, value);
    else next.delete(name);
    router.push(`/dashboard/${kind}?${next}`, { scroll: false });
  };
  const title = kind === "events" ? "Eventos" : "Alertas";
  return (
    <>
      <Title
        title={title}
        description={
          kind === "events"
            ? "Os eventos recebidos da sua aplicação, em ordem de recebimento."
            : "Revise os sinais e acompanhe o estado de cada investigação."
        }
      />
      <div className="filter-bar">
        <EnvironmentFilter
          value={params.get("environment") ?? ""}
          change={(value) => change("environment", value)}
        />
        {kind === "alerts" ? (
          <>
            <label>
              Estado
              <select
                value={params.get("status") ?? ""}
                onChange={(e) => change("status", e.target.value)}
              >
                <option value="">Todos os estados</option>
                {Object.entries(statusNames).map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Regra
              <select
                value={params.get("ruleCode") ?? ""}
                onChange={(e) => change("ruleCode", e.target.value)}
              >
                <option value="">Todas as regras</option>
                {Object.entries(ruleNames).map(([value, name]) => (
                  <option key={value} value={value}>
                    {value} — {name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <label>
              Tipo
              <select
                value={params.get("type") ?? ""}
                onChange={(e) => change("type", e.target.value)}
              >
                <option value="">Todos os tipos</option>
                {Object.entries(eventNames).map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              De (horário local)
              <input
                type="datetime-local"
                value={localDate(params.get("from"))}
                onChange={(e) =>
                  change(
                    "from",
                    e.target.value
                      ? new Date(e.target.value).toISOString()
                      : "",
                  )
                }
              />
            </label>
            <label>
              Até (horário local)
              <input
                type="datetime-local"
                value={localDate(params.get("to"))}
                onChange={(e) =>
                  change(
                    "to",
                    e.target.value
                      ? new Date(e.target.value).toISOString()
                      : "",
                  )
                }
              />
            </label>
          </>
        )}
        {search.size > 1 && (
          <Button variant="ghost" onClick={() => router.push(href(`/${kind}`))}>
            Limpar filtros
          </Button>
        )}
      </div>
      <section className="panel list-panel">
        {result.isPending ? (
          <Loading />
        ) : result.error ? (
          <ErrorState
            error={result.error}
            retry={() => {
              void result.refetch();
            }}
          />
        ) : result.data?.items.length ? (
          kind === "events" ? (
            <EventTable items={result.data.items as Event[]} />
          ) : (
            <AlertTable items={result.data.items as Alert[]} />
          )
        ) : (
          <Empty
            title={`Nenhum ${kind === "events" ? "evento" : "alerta"} encontrado`}
          >
            <p>Confira os filtros ou aguarde novos eventos da aplicação.</p>
            <Link href={href("/integration")}>Ver a integração</Link>
          </Empty>
        )}
      </section>
      <div className="pagination">
        <span>{result.data?.items.length ?? 0} resultados nesta página</span>
        {params.has("cursor") && (
          <Button variant="outline" onClick={() => change("cursor", "")}>
            <ArrowLeft aria-hidden="true" />
            Voltar ao início
          </Button>
        )}
        <Button
          variant="outline"
          disabled={!result.data?.nextCursor}
          onClick={() => {
            if (result.data?.nextCursor)
              change("cursor", result.data.nextCursor);
          }}
        >
          Próxima página
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    </>
  );
}
function localDate(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
export function EventBody({ event }: { event: Event }) {
  return (
    <dl className="event-fields">
      <div>
        <dt>Tipo</dt>
        <dd>{event.payload.type}</dd>
      </div>
      <div>
        <dt>Ação / resultado</dt>
        <dd>
          {event.payload.action} / {event.payload.outcome}
        </dd>
      </div>
      <div>
        <dt>Ator</dt>
        <dd>{event.payload.actor_id ?? "Não informado"}</dd>
      </div>
      <div>
        <dt>IP de origem</dt>
        <dd>{event.payload.source_ip ?? "Não informado"}</dd>
      </div>
      {event.payload.actor_role && (
        <div>
          <dt>Papel na aplicação</dt>
          <dd>{event.payload.actor_role}</dd>
        </div>
      )}
      {event.payload.resource && (
        <div>
          <dt>Recurso</dt>
          <dd className="break-value">{event.payload.resource}</dd>
        </div>
      )}
      {event.payload.request_id && (
        <div>
          <dt>ID da requisição</dt>
          <dd className="break-value">{event.payload.request_id}</dd>
        </div>
      )}
      <div>
        <dt>Ocorrido em</dt>
        <dd>{date(event.payload.occurred_at)}</dd>
      </div>
      <div>
        <dt>Recebido em</dt>
        <dd>{date(event.receivedAt)}</dd>
      </div>
      <div>
        <dt>ID do evento</dt>
        <dd className="break-value">{event.id}</dd>
      </div>
      {Object.entries(event.payload.metadata).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd className="break-value">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
export function EventView({ id }: { id: string }) {
  const { base, href } = useScope();
  const result = useData<Event>(`${base}/events/${id}`);
  return (
    <>
      <Link className="back-link" href={href("/events")}>
        <ArrowLeft aria-hidden="true" />
        Todos os eventos
      </Link>
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
            <Title
              title={eventNames[result.data.payload.type] ?? "Evento"}
              description={`Ambiente ${result.data.payload.environment}. Conteúdo validado recebido da aplicação.`}
            />
            <section className="panel">
              <EventBody event={result.data} />
            </section>
          </>
        )
      )}
    </>
  );
}

export function AlertView({ id }: { id: string }) {
  const { base } = useScope();
  return <AlertPanel key={`${base}/${id}`} id={id} />;
}
function AlertPanel({ id }: { id: string }) {
  const { base, href, organization, session, refresh } = useScope();
  const result = useData<Alert>(`${base}/alerts/${id}`),
    [cursor, setCursor] = useState("");
  const evidence = useData<Page<Event>>(
    `${base}/alerts/${id}/evidence?limit=25${cursor ? `&cursor=${cursor}` : ""}`,
  );
  const [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false),
    [failure, setFailure] = useState("");
  const [decision, setDecision] = useState<"initialDecision" | "lastDecision">(
    "initialDecision",
  );
  const alert = result.data;
  return (
    <>
      <Link className="back-link" href={href("/alerts")}>
        <ArrowLeft aria-hidden="true" />
        Todos os alertas
      </Link>
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
        alert && (
          <>
            <div className="investigation-heading">
              <Title
                title={ruleNames[alert.ruleCode] ?? alert.ruleCode}
                description={`${alert.ruleCode} v${alert.ruleVersion} · ${alert.environment} · Criado em ${date(alert.createdAt)}`}
              />
              <div>
                <Severity severity={alert.severity} />
                <Badge alert={alert} />
              </div>
            </div>
            <div className="investigation-grid">
              <section className="decision-panel">
                <div className="section-heading">
                  <h2>Por que gerou um alerta</h2>
                  <label className="decision-picker">
                    <span className="sr-only">Decisão</span>
                    <select
                      value={decision}
                      onChange={(e) =>
                        setDecision(e.target.value as typeof decision)
                      }
                    >
                      <option value="initialDecision">Decisão inicial</option>
                      <option value="lastDecision">Última decisão</option>
                    </select>
                  </label>
                </div>
                <p className="decision-reason">
                  {alert[decision].reason === "privilege_change"
                    ? "Uma mudança explícita de privilégio foi registrada."
                    : alert[decision].reason ===
                        "critical_action_after_failures"
                      ? "Uma ação crítica foi realizada após falhas de login do mesmo ator."
                      : "O número de eventos atingiu o limiar da regra nesta janela."}
                </p>
                <dl className="decision-stats">
                  <div>
                    <dt>Contagem na janela</dt>
                    <dd>{alert[decision].count}</dd>
                  </div>
                  <div>
                    <dt>Limiar aplicado</dt>
                    <dd>{alert[decision].threshold}</dd>
                  </div>
                  <div>
                    <dt>Janela</dt>
                    <dd>{alert[decision].windowSeconds / 60} min</dd>
                  </div>
                </dl>
                <p className="muted">
                  {date(alert[decision].windowStart)} até{" "}
                  {date(alert[decision].windowEnd)}. Base: recebimento no
                  Sentinel.
                </p>
                <p>
                  Correlação por{" "}
                  {alert.correlation.kind === "ip" ? "IP" : "ator"}:{" "}
                  <strong className="break-value">
                    {alert.correlation.value}
                  </strong>
                  .
                </p>
                {alert[
                  decision === "initialDecision"
                    ? "initialTriggerRawAvailable"
                    : "lastTriggerRawAvailable"
                ] ? (
                  <Link
                    href={href(`/events/${alert[decision].triggerEventId}`)}
                  >
                    Abrir o evento que disparou esta decisão
                  </Link>
                ) : (
                  <p>
                    Evento gatilho expirou; consulte as evidências preservadas
                    abaixo.
                  </p>
                )}
                <p className="muted">
                  Pico de contagem: {alert.peakCount}.{" "}
                  {alert.episode.totalRelevant} eventos relevantes no episódio.{" "}
                  {alert.episode.endedAt
                    ? `Encerrado em ${date(alert.episode.endedAt)}.`
                    : "O encerramento por silêncio é verificado no próximo evento relevante."}
                </p>
              </section>
              <aside className="triage-panel">
                <h2>Estado da investigação</h2>
                <p className="muted">
                  Mudar o estado registra sua ação na auditoria.
                </p>
                {organization.role === "reader" ? (
                  <p>
                    Seu papel permite consultar evidências. Um analista ou
                    administrador pode mudar o estado.
                  </p>
                ) : (
                  <form
                    key={alert.statusVersion}
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const next = new FormData(e.currentTarget).get("status");
                      setPending(true);
                      setFailure("");
                      setNotice("");
                      try {
                        await request(`${base}/alerts/${id}`, {
                          method: "PATCH",
                          headers: { "x-csrf-token": session.csrfToken },
                          body: JSON.stringify({
                            status: next,
                            expectedVersion: alert.statusVersion,
                          }),
                        });
                        setNotice("Estado atualizado.");
                        await refresh();
                      } catch (error) {
                        setFailure(
                          error instanceof Error
                            ? error.message
                            : "Tente novamente.",
                        );
                        await result.refetch();
                      } finally {
                        setPending(false);
                      }
                    }}
                  >
                    <label>
                      Estado
                      <select name="status" defaultValue={alert.status}>
                        {Object.entries(statusNames).map(([value, name]) => (
                          <option key={value} value={value}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button disabled={pending} type="submit">
                      {pending ? "Salvando…" : "Salvar estado"}
                    </Button>
                  </form>
                )}
                <p className="success-message" role="status">
                  {notice && (
                    <>
                      <Check aria-hidden="true" />
                      {notice}
                    </>
                  )}
                </p>
                {failure && (
                  <p role="alert" className="form-error">
                    {failure}
                  </p>
                )}
                <p className="triage-note">
                  Resolver não abre outro alerta no mesmo episódio. Novas
                  evidências continuam vinculadas.
                </p>
              </aside>
            </div>
            <section className="evidence-section">
              <div className="section-heading">
                <h2>Timeline de evidências</h2>
                <span className="muted">Ordem de recebimento</span>
              </div>
              {alert.evidenceTruncated && (
                <p className="feedback warning">
                  <CircleAlert aria-hidden="true" />
                  Este alerta atingiu o limite de 200 evidências. A contagem e
                  os gatilhos das decisões continuam disponíveis.
                </p>
              )}
              <p className="muted">
                Evidências acumuladas do episódio podem estar fora da última
                janela.
              </p>
              {evidence.isPending ? (
                <Loading />
              ) : evidence.error ? (
                <ErrorState
                  error={evidence.error}
                  retry={() => {
                    void evidence.refetch();
                  }}
                />
              ) : (
                <ol className="evidence-timeline">
                  {evidence.data?.items.map((e) => (
                    <li
                      key={e.id}
                      className={e.role === "trigger" ? "trigger" : ""}
                    >
                      <time dateTime={e.receivedAt}>{date(e.receivedAt)}</time>
                      <div className="evidence-entry">
                        <div className="section-heading">
                          <strong>
                            {eventNames[e.payload.type] ?? e.payload.type}
                          </strong>
                          <span className={`evidence-role ${e.role}`}>
                            {e.role === "trigger"
                              ? "Gatilho"
                              : e.role === "context"
                                ? "Contexto"
                                : "Suporte"}
                          </span>
                        </div>
                        <p>
                          {e.payload.actor_id ?? "Ator não informado"}{" "}
                          {e.payload.source_ip && `· ${e.payload.source_ip}`}
                        </p>
                        <details>
                          <summary>Inspecionar evento</summary>
                          <EventBody event={e} />
                          {e.rawAvailable ? (
                            <Link href={href(`/events/${e.id}`)}>
                              Abrir evento completo
                            </Link>
                          ) : (
                            <p>
                              Evento original expirou pela retenção. Esta
                              evidência foi preservada.
                            </p>
                          )}
                        </details>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              <div className="pagination">
                {cursor && (
                  <Button variant="outline" onClick={() => setCursor("")}>
                    Voltar ao início
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={!evidence.data?.nextCursor}
                  onClick={() => {
                    if (evidence.data?.nextCursor)
                      setCursor(evidence.data.nextCursor);
                  }}
                >
                  Próximas evidências
                  <ArrowRight aria-hidden="true" />
                </Button>
              </div>
            </section>
          </>
        )
      )}
    </>
  );
}
