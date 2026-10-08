"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bell,
  Cable,
  FolderPlus,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  ApiError,
  type Organization,
  type Project,
  request,
  type Session,
} from "../lib/models";
import { Empty, ErrorState, Loading } from "./feedback";
import { Button } from "./ui/button";

type Scope = {
  session: Session;
  organization: Organization;
  project: Project;
  base: string;
  href: (path: string) => string;
  refresh: () => Promise<void>;
};
const Context = createContext<Scope | null>(null);
export function useScope() {
  const scope = useContext(Context);
  if (!scope) throw new Error("Workspace scope required");
  return scope;
}
function useLive(base: string, active: boolean) {
  const cache = useQueryClient(),
    [state, setState] = useState("Conectando atualização ao vivo");
  useEffect(() => {
    if (!active) return;
    let stopped = false,
      dirty = false;
    const refresh = () => {
      if (document.hidden) {
        dirty = true;
        return;
      }
      dirty = false;
      void cache.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith(base),
      });
      void cache.invalidateQueries({ queryKey: ["organizations"] });
    };
    const connect = () => {
      const channel = new EventSource(`/api${base}/stream`);
      channel.onopen = () => {
        setState("Atualização ao vivo");
        refresh();
      };
      channel.addEventListener("refresh", refresh);
      channel.addEventListener("unavailable", () => {
        setState("Reconectando. Dados da última consulta.");
      });
      channel.addEventListener("access-lost", () => {
        channel.close();
        stopped = true;
        setState("Acesso encerrado");
        cache.removeQueries({
          predicate: (q) =>
            typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith(base),
        });
        void cache.invalidateQueries({ queryKey: ["session"] });
        void cache.invalidateQueries({ queryKey: ["organizations"] });
      });
      channel.onerror = () => {
        if (!stopped) setState("Reconectando. Dados da última consulta.");
      };
      return channel;
    };
    let source = connect();
    const interval = setInterval(() => {
      if (!stopped && source.readyState !== EventSource.OPEN) refresh();
    }, 10_000);
    const visible = () => {
      if (
        !document.hidden &&
        !stopped &&
        (dirty || source.readyState !== EventSource.OPEN)
      )
        refresh();
    };
    const online = () => {
      if (!stopped) {
        source.close();
        source = connect();
        refresh();
      }
    };
    const offline = () => {
      if (!stopped) {
        source.close();
        setState("Reconectando. Dados da última consulta.");
      }
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      stopped = true;
      source.close();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [active, base, cache]);
  return state;
}

function CreateProject({
  organization,
  csrf,
  done,
}: {
  organization: Organization;
  csrf: string;
  done: () => Promise<void>;
}) {
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  return (
    <form
      className="create-project"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        setPending(true);
        setError("");
        try {
          await request(`/v1/organizations/${organization.id}/projects`, {
            method: "POST",
            headers: { "x-csrf-token": csrf },
            body: JSON.stringify({ name: new FormData(form).get("name") }),
          });
          form.reset();
          await done();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Tente novamente.");
        } finally {
          setPending(false);
        }
      }}
    >
      <label>
        Nome do projeto
        <input
          name="name"
          required
          minLength={2}
          maxLength={80}
          placeholder="Minha aplicação"
        />
      </label>
      <Button disabled={pending} type="submit">
        <FolderPlus aria-hidden="true" />
        {pending ? "Criando…" : "Criar projeto"}
      </Button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </form>
  );
}
export function Workspace({ children }: { children: ReactNode }) {
  const router = useRouter(),
    pathname = usePathname(),
    params = useSearchParams(),
    cache = useQueryClient();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => request<Session>("/v1/auth/session", { signal }),
    staleTime: 0,
  });
  const organizations = useQuery({
    queryKey: ["organizations"],
    queryFn: ({ signal }) =>
      request<Organization[]>("/v1/organizations", { signal }),
    enabled: Boolean(session.data),
  });
  const orgId = params.get("org") ?? organizations.data?.[0]?.id;
  const organization = organizations.data?.find((o) => o.id === orgId);
  const projects = useQuery({
    queryKey: ["projects", orgId],
    queryFn: ({ signal }) =>
      request<Project[]>(`/v1/organizations/${orgId}/projects`, { signal }),
    enabled: Boolean(organization),
  });
  const projectId = params.get("project") ?? projects.data?.[0]?.id;
  const project = projects.data?.find((p) => p.id === projectId);
  const base =
    organization && project
      ? `/v1/organizations/${organization.id}/projects/${project.id}`
      : "";
  const live = useLive(base, Boolean(base && session.data));
  const [adding, setAdding] = useState(false),
    [logoutError, setLogoutError] = useState(""),
    [logoutPending, setLogoutPending] = useState(false);
  useEffect(() => {
    if (session.error instanceof ApiError && session.error.status === 401) {
      cache.clear();
      router.replace("/login");
    }
  }, [session.error, cache, router]);
  const href = (path: string) =>
    `/dashboard${path}?${new URLSearchParams({ org: orgId ?? "", project: projectId ?? "" })}`;
  const refresh = async () => {
    await cache.invalidateQueries({
      predicate: (q) =>
        (typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith(base)) ||
        q.queryKey[0] === "organizations" ||
        q.queryKey[0] === "projects",
    });
  };
  if (session.isPending) return <Loading />;
  if (session.error)
    return (
      <ErrorState
        error={session.error}
        retry={() => {
          void session.refetch();
        }}
      />
    );
  if (!session.data) return null;
  const links = [
    { path: "", title: "Visão geral", Icon: LayoutDashboard },
    { path: "/alerts", title: "Alertas", Icon: Bell },
    { path: "/events", title: "Eventos", Icon: Activity },
    { path: "/integration", title: "Integração", Icon: Cable },
  ];
  return (
    <div className="workspace">
      <a href="#workspace-content" className="skip-link">
        Pular para o conteúdo
      </a>
      <aside className="sidebar">
        <Link href="/" className="brand">
          <ShieldCheck aria-hidden="true" />
          Sentinel
        </Link>
        <p className="sidebar-caption">Workspace de segurança</p>
        <nav aria-label="Navegação do workspace">
          {links.map(({ path, title, Icon }) => (
            <Link
              key={path}
              href={href(path)}
              aria-current={
                path
                  ? pathname.startsWith(`/dashboard${path}`)
                    ? "page"
                    : undefined
                  : pathname === "/dashboard"
                    ? "page"
                    : undefined
              }
            >
              <Icon aria-hidden="true" />
              {title}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a href="https://github.com/samuelsce/Sentinel">
            Documentação do projeto
          </a>
          <span className="account-email">{session.data.user.email}</span>
          <Button
            variant="ghost"
            disabled={logoutPending}
            onClick={async () => {
              setLogoutPending(true);
              setLogoutError("");
              try {
                await request("/v1/auth/logout", {
                  method: "POST",
                  headers: { "x-csrf-token": session.data.csrfToken },
                });
                cache.clear();
                router.replace("/login");
              } catch (err) {
                setLogoutError(
                  err instanceof Error ? err.message : "Tente novamente.",
                );
              } finally {
                setLogoutPending(false);
              }
            }}
          >
            <LogOut aria-hidden="true" />
            {logoutPending ? "Saindo…" : "Sair"}
          </Button>
          {logoutError && <p role="alert">{logoutError}</p>}
        </div>
      </aside>
      <div className="workspace-main">
        <header className="workspace-header">
          <div className="scope-selects">
            <label>
              Organização
              <select
                aria-label="Organização"
                value={organization?.id ?? ""}
                onChange={(e) => {
                  setAdding(false);
                  router.push(`/dashboard?org=${e.target.value}`);
                }}
              >
                <option value="" disabled>
                  Selecione
                </option>
                {organizations.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Projeto
              <select
                aria-label="Projeto"
                value={project?.id ?? ""}
                onChange={(e) =>
                  router.push(
                    `/dashboard?org=${orgId}&project=${e.target.value}`,
                  )
                }
              >
                <option value="" disabled>
                  Selecione
                </option>
                {projects.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {organization?.role === "admin" && (
              <Button
                variant="ghost"
                aria-expanded={adding}
                onClick={() => setAdding(!adding)}
              >
                <FolderPlus aria-hidden="true" />
                Novo projeto
              </Button>
            )}
          </div>
          <span className="role-label">
            {organization
              ? {
                  admin: "Administrador",
                  analyst: "Analista",
                  reader: "Leitor",
                }[organization.role]
              : ""}
          </span>
        </header>
        <main
          id="workspace-content"
          tabIndex={-1}
          className="workspace-content"
        >
          {adding && organization?.role === "admin" && (
            <section className="panel">
              <h2>Novo projeto</h2>
              <CreateProject
                key={organization.id}
                organization={organization}
                csrf={session.data.csrfToken}
                done={async () => {
                  await projects.refetch();
                  setAdding(false);
                }}
              />
            </section>
          )}
          {organizations.isPending || (organization && projects.isPending) ? (
            <Loading />
          ) : organizations.error ? (
            <ErrorState
              error={organizations.error}
              retry={() => {
                void organizations.refetch();
              }}
            />
          ) : projects.error ? (
            <ErrorState
              error={projects.error}
              retry={() => {
                void projects.refetch();
              }}
            />
          ) : !organization ? (
            <Empty title="Nenhuma organização disponível">
              <p>
                Seu administrador precisa vincular sua conta a uma organização
                ativa.
              </p>
              <Link href="/dashboard">Conferir meus workspaces</Link>
            </Empty>
          ) : !project ? (
            <Empty
              title={
                params.has("project")
                  ? "Projeto indisponível"
                  : "Comece por um projeto"
              }
            >
              <p>
                Um projeto organiza os eventos, alertas e chaves de uma
                aplicação.
              </p>
              {params.has("project") && (
                <Link href={`/dashboard?org=${orgId}`}>
                  Conferir os projetos disponíveis
                </Link>
              )}
              {organization.role === "admin" ? (
                <CreateProject
                  organization={organization}
                  csrf={session.data.csrfToken}
                  done={async () => {
                    await projects.refetch();
                    router.replace(`/dashboard?org=${orgId}`);
                  }}
                />
              ) : (
                <p>Peça ao administrador para criar ou liberar um projeto.</p>
              )}
            </Empty>
          ) : (
            <Context
              value={{
                session: session.data,
                organization,
                project,
                base,
                href,
                refresh,
              }}
            >
              <div className="live-toolbar">
                <span
                  className={
                    live === "Atualização ao vivo" ? "live connected" : "live"
                  }
                >
                  <span aria-hidden="true" />
                  {live}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void refresh();
                  }}
                >
                  <RefreshCw aria-hidden="true" />
                  Atualizar dados
                </Button>
              </div>
              {children}
            </Context>
          )}
        </main>
      </div>
    </div>
  );
}
