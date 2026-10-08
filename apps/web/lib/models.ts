export type Role = "admin" | "analyst" | "reader";
export type Session = {
  user: { id: string; email: string };
  csrfToken: string;
  expiresAt: string;
};
export type Organization = { id: string; name: string; role: Role };
export type Project = { id: string; name: string; createdAt: string };
export type Page<T> = { items: T[]; nextCursor: string | null };
export type Event = {
  id: string;
  receivedAt: string;
  payload: {
    event_id: string;
    occurred_at: string;
    environment: string;
    type: string;
    action: string;
    outcome: string;
    actor_id?: string;
    actor_role?: "user" | "admin" | "service";
    request_id?: string;
    source_ip?: string;
    resource?: string;
    metadata: Record<string, string>;
  };
  role?: "trigger" | "support" | "context";
  rawAvailable?: boolean;
};
export type Decision = {
  timeBasis: "received_at";
  windowSeconds: number;
  threshold: number;
  windowStart: string;
  windowEnd: string;
  count: number;
  triggerEventId: string;
  reason: string;
};
export type Alert = {
  id: string;
  environment: string;
  ruleCode: string;
  ruleVersion: number;
  severity: "high" | "medium";
  status: "open" | "triaged" | "resolved";
  statusVersion: number;
  correlation: { kind: string; value: string };
  episode: {
    id: string;
    startedAt: string;
    lastRelevantAt: string;
    endedAt: string | null;
    totalRelevant: number;
  };
  initialDecision: Decision;
  lastDecision: Decision;
  peakCount: number;
  evidenceTruncated: boolean;
  initialTriggerRawAvailable: boolean;
  lastTriggerRawAvailable: boolean;
  createdAt: string;
  updatedAt: string;
};
export type Rule = {
  code: string;
  version: number;
  title: string;
  severity: string;
  windowSeconds: number;
  threshold: number;
  criticalActions: string[];
};
export type Key = {
  id: string;
  prefix: string;
  environment: string;
  createdAt: string;
  revokedAt: string | null;
};
export type Overview = {
  asOf: string;
  since: string;
  events24h: number;
  openAlerts: number;
  triagedAlerts: number;
  resolvedAlerts: number;
  pendingJobs: number;
  failedJobs: number;
  lastReceivedAt: string | null;
  activity: { hour: string; count: number }[];
};
export const environments = [
  "demo",
  "development",
  "test",
  "staging",
  "production",
];
export const statusNames = {
  open: "Aberto",
  triaged: "Em análise",
  resolved: "Resolvido",
};
export const ruleNames: Record<string, string> = {
  "AUTH-001": "Falhas repetidas de login",
  "AUTHZ-001": "Acessos negados em sequência",
  "ADMIN-001": "Atividade administrativa suspeita",
};
export const eventNames: Record<string, string> = {
  "auth.login_failed": "Login recusado",
  "auth.login_succeeded": "Login realizado",
  "authz.access_denied": "Acesso negado",
  "admin.action": "Ação administrativa",
  "admin.privilege_changed": "Privilégio alterado",
};
export function date(value: string) {
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
  });
}
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "Sua sessão terminou. Entre novamente."
        : status === 403
          ? "Seu papel não permite esta ação."
          : status === 404
            ? "Este recurso não está disponível para sua conta."
            : status === 409
              ? "O alerta mudou em outra sessão. Confira o estado atualizado antes de tentar novamente."
              : status === 429
                ? "Muitas tentativas. Aguarde um momento e tente novamente."
                : status >= 500
                  ? "O serviço está indisponível. Tente novamente."
                  : "Confira os campos informados.",
    );
  }
}
export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers,
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
