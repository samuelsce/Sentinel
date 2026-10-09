import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { createDatabase } from "../../../packages/database/src/index.js";
import { retainProject } from "../../../packages/database/src/retention.js";

const fixture = JSON.parse(process.env.M5_FIXTURE ?? "null") as {
  credentials: Record<
    "admin" | "analyst" | "reader" | "operator",
    { email: string; password: string }
  >;
  api: string;
  base: string;
  key: string;
  org: string;
  project: string;
  foreignOrg: string;
  foreignProject: string;
} | null;
if (!fixture)
  throw new Error("Run through pnpm test:web to provision isolated fixtures");
const f = fixture;
async function login(page: Page, role: keyof typeof f.credentials = "admin") {
  await page.goto("/login");
  await page.getByLabel("Email").fill(f.credentials[role].email);
  await page
    .getByLabel("Senha", { exact: true })
    .fill(f.credentials[role].password);
  await page
    .getByRole("button", { name: "Entrar no Sentinel", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Visão geral", exact: true }),
  ).toBeVisible();
}
async function screenshot(page: Page, name: string) {
  await mkdir("test-results/screenshots", { recursive: true });
  // Only fabricated test data. Omit generated account identifiers from portfolio artifacts.
  await page.screenshot({
    path: resolve(`test-results/screenshots/${name}.png`),
    fullPage: true,
    mask: [page.locator(".account-email")],
    maskColor: "#edf2f8",
  });
}
async function emit() {
  const response = await fetch(`${f.api}/v1/ingest/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${f.key}`,
    },
    body: JSON.stringify({
      events: [
        {
          schema_version: 1,
          event_id: randomUUID(),
          occurred_at: new Date().toISOString(),
          type: "auth.login_failed",
          environment: "demo",
          action: "log_in",
          outcome: "failure",
          actor_id: "live-user",
          metadata: { reason: "invalid_credentials" },
        },
      ],
    }),
  });
  expect(response.status).toBe(202);
}

test("login, real demo counts, empty filters, scoped workspace and logout", async ({
  page,
  context,
}) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
  await login(page);
  await expect(page.getByTestId("events-count")).toHaveText("22");
  await expect(page.getByTestId("open-alerts-count")).toHaveText("3");
  await expect(
    page.getByText("Atualização ao vivo", { exact: true }),
  ).toBeVisible();
  const cookies = await context.cookies();
  expect(
    cookies.some(
      (cookie) =>
        cookie.name === "sentinel_session" &&
        cookie.httpOnly &&
        cookie.sameSite === "Lax",
    ),
  ).toBe(true);
  await screenshot(page, "m5-overview");
  await page
    .getByRole("combobox", { name: "Ambiente", exact: true })
    .selectOption("production");
  await expect(page.getByTestId("events-count")).toHaveText("0");
  await expect(
    page.getByRole("heading", { name: "Nenhum alerta recebido" }),
  ).toBeVisible();
  await page.goto(`/dashboard?org=${f.foreignOrg}&project=${f.foreignProject}`);
  await expect(
    page.getByRole("heading", { name: "Nenhuma organização disponível" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("events paginate without duplicates; filters persist in URL and show validated detail", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("link", { name: "Eventos", exact: true }).click();
  await expect(page.getByText("20 resultados nesta página")).toBeVisible();
  const first = await page
    .locator("tbody .row-link")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
  await page.getByRole("button", { name: "Próxima página" }).click();
  await expect(page.getByText("2 resultados nesta página")).toBeVisible();
  const next = await page
    .locator("tbody .row-link")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
  expect(next.every((id) => !first.includes(id))).toBe(true);
  await page
    .getByRole("combobox", { name: "Tipo", exact: true })
    .selectOption("authz.access_denied");
  await expect(page).toHaveURL(/type=authz.access_denied/);
  await expect(page.getByText("10 resultados nesta página")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Tipo", exact: true }),
  ).toHaveValue("authz.access_denied");
  await page.locator("tbody .row-link").first().click();
  await expect(
    page.getByRole("heading", { name: "Acesso negado", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("ID do evento", { exact: true })).toBeVisible();
  await expect(
    page.getByText("/admin/settings", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Papel na aplicação", { exact: true }),
  ).toBeVisible();
});

test("analyst investigates real evidence, changes status and receives conflict feedback", async ({
  page,
  context,
}) => {
  await login(page, "analyst");
  await page.getByRole("link", { name: "Alertas", exact: true }).click();
  await page
    .getByRole("link", { name: "Falhas repetidas de login", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Timeline de evidências" }),
  ).toBeVisible();
  await expect(page.locator(".evidence-role.trigger").first()).toHaveText(
    "Gatilho",
  );
  await page.locator(".evidence-entry summary").first().click();
  await expect(
    page
      .locator(".evidence-entry")
      .first()
      .getByText("invalid_credentials", { exact: true }),
  ).toBeVisible();
  await screenshot(page, "m5-investigation");
  await page
    .getByRole("combobox", { name: "Estado", exact: true })
    .selectOption("triaged");
  await page.getByRole("button", { name: "Salvar estado" }).click();
  await expect(
    page.getByText("Estado atualizado.", { exact: true }),
  ).toBeVisible();
  const session = await (
    await context.request.get("/api/v1/auth/session")
  ).json();
  const alertId = new URL(page.url()).pathname.split("/").at(-1);
  const conflict = await context.request.patch(
    `/api${f.base}/alerts/${alertId}`,
    {
      headers: {
        origin: "http://localhost:3300",
        "x-csrf-token": session.csrfToken,
      },
      data: { status: "resolved", expectedVersion: 1 },
    },
  );
  expect(conflict.status()).toBe(409);
  // A concurrent operator response is shown to the user; never silently retry a mutation.
  await page.route("**/api/**/alerts/*", async (route) => {
    if (route.request().method() === "PATCH")
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: '{"message":"Invalid request"}',
      });
    else await route.continue();
  });
  await page
    .getByRole("combobox", { name: "Estado", exact: true })
    .selectOption("resolved");
  await page.getByRole("button", { name: "Salvar estado" }).click();
  await expect(page.locator('.form-error[role="alert"]')).toContainText(
    "O recurso mudou ou já existe",
  );
});

test("reader can investigate but cannot mutate or manage keys", async ({
  page,
  context,
}) => {
  await login(page, "reader");
  await expect(page.getByText("Leitor", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Alertas", exact: true }).click();
  await page.locator("tbody .row-link").first().click();
  await expect(
    page.getByText("Seu papel permite consultar evidências.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Salvar estado" })).toHaveCount(
    0,
  );
  const session = await (
    await context.request.get("/api/v1/auth/session")
  ).json();
  const alertId = new URL(page.url()).pathname.split("/").at(-1);
  expect(
    (
      await context.request.patch(`/api${f.base}/alerts/${alertId}`, {
        headers: {
          origin: "http://localhost:3300",
          "x-csrf-token": session.csrfToken,
        },
        data: { status: "resolved", expectedVersion: 2 },
      })
    ).status(),
  ).toBe(403);
  await page.getByRole("link", { name: "Integração", exact: true }).click();
  await expect(page.getByRole("button", { name: "Gerar chave" })).toHaveCount(
    0,
  );
});

test("admin issues one-time credentials and revokes with keyboard confirmation", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("link", { name: "Integração", exact: true }).click();
  await page.getByRole("button", { name: "Gerar chave", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Chave de ingestão", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Ocultar chave", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Chave de ingestão", exact: true }),
  ).toHaveCount(0);
  const row = page.locator("tbody tr").last();
  await row.getByRole("button", { name: "Revogar chave", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Cancelar", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    row.getByRole("button", { name: "Revogar chave", exact: true }),
  ).toBeFocused();
  await row.getByRole("button", { name: "Revogar chave", exact: true }).click();
  await row.getByRole("button", { name: "Revogar", exact: true }).click();
  await expect(row.getByText("Revogada", { exact: true })).toBeVisible();
});

test("live event and offline reconnect recover server state without reloading", async ({
  page,
  context,
}) => {
  await login(page);
  await expect(page.getByTestId("events-count")).toHaveText("22");
  await expect(
    page.getByText("Atualização ao vivo", { exact: true }),
  ).toBeVisible();
  await emit();
  await expect(page.getByTestId("events-count")).toHaveText("23");
  await context.setOffline(true);
  await expect(
    page.getByText("Reconectando. Dados da última consulta.", { exact: true }),
  ).toBeVisible();
  await emit();
  await context.setOffline(false);
  await expect(page.getByTestId("events-count")).toHaveText("24");
  await expect(
    page.getByText("Atualização ao vivo", { exact: true }),
  ).toBeVisible();
});

test("mobile, keyboard focus, reduced motion, API error and retry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Keep this error/retry scenario independent of automatic SSE recovery.
  await page.route("**/api/**/stream", (route) => route.abort());
  await login(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await screenshot(page, "m5-mobile");
  await page.getByRole("link", { name: "Alertas", exact: true }).click();
  await page.locator("tbody .row-link").first().click();
  await expect(
    page.getByRole("heading", { name: "Timeline de evidências" }),
  ).toBeVisible();
  await expect(page.locator(".evidence-entry").first()).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await screenshot(page, "m5-mobile-investigation");
  await page.getByRole("link", { name: "Eventos", exact: true }).click();
  await page.route("**/api/**/events?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"message":"Invalid request"}',
    }),
  );
  await page
    .getByRole("combobox", { name: "Tipo", exact: true })
    .selectOption("auth.login_failed");
  await expect(page.locator('.feedback[role="alert"]')).toContainText(
    "O serviço está indisponível",
  );
  const retried = page.waitForRequest(
    (request) =>
      request.url().includes("/events?") &&
      request.url().includes("type=auth.login_failed"),
  );
  await page
    .getByRole("button", { name: "Tentar novamente", exact: true })
    .click();
  await retried;
  await page.unroute("**/api/**/events?**");
  await page
    .getByRole("button", { name: "Atualizar dados", exact: true })
    .click();
  await expect(page.getByRole("table")).toBeVisible();
  const scroll = page.getByRole("region", { name: "Tabela de eventos" });
  await scroll.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(0);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Tab");
  await page
    .getByRole("link", { name: "Pular para o conteúdo", exact: true })
    .focus();
  await expect(
    page.getByRole("link", { name: "Pular para o conteúdo", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#workspace-content")).toBeFocused();
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
});

test("project onboarding starts empty and receives no other project's data", async ({
  page,
}) => {
  await login(page, "operator");
  await page.getByRole("button", { name: "Novo projeto", exact: true }).click();
  await page.getByLabel("Nome do projeto").fill("New empty application");
  await page
    .getByRole("button", { name: "Criar projeto", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Projeto", exact: true }),
  ).toContainText("New empty application");
  await page
    .getByRole("combobox", { name: "Projeto", exact: true })
    .selectOption({ label: "New empty application" });
  await expect(page.getByTestId("events-count")).toHaveText("0");
  await expect(page.getByTestId("open-alerts-count")).toHaveText("0");
});

test("three real detection timelines remain readable after retention", async ({
  page,
  context,
}) => {
  await login(page, "analyst");
  await page
    .getByRole("combobox", { name: "Projeto", exact: true })
    .selectOption(f.project);
  for (const [name, code] of [
    ["Falhas repetidas de login", "AUTH-001"],
    ["Acessos negados em sequência", "AUTHZ-001"],
    ["Atividade administrativa suspeita", "ADMIN-001"],
  ] as const) {
    await page.getByRole("link", { name: "Alertas", exact: true }).click();
    await page.getByRole("link", { name, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Timeline de evidências" }),
    ).toBeVisible();
    await expect(page.locator(".evidence-role.trigger").first()).toHaveText(
      "Gatilho",
    );
    await page.locator(".evidence-entry summary").first().click();
    await screenshot(page, `m6-${code}`);
  }
  expect((await context.request.get(`/api${f.base}/metrics`)).status()).toBe(
    200,
  );
  const url = process.env.TEST_DATABASE_URL;
  expect(url && new URL(url).pathname).toBe("/sentinel_test");
  const { pool } = createDatabase(url ?? "");
  try {
    const detectorUrl = new URL(url ?? "");
    detectorUrl.username = "sentinel_detector";
    detectorUrl.password = process.env.SENTINEL_DETECTOR_DB_PASSWORD ?? "";
    await promisify(execFile)(
      resolve(
        "services/detector/.venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      ),
      ["-m", "sentinel_detector.worker", "--drain", "--project", f.project],
      {
        cwd: resolve("services/detector"),
        env: { ...process.env, DETECTOR_DATABASE_URL: detectorUrl.href },
        timeout: 30000,
      },
    );
    await pool.query(
      "UPDATE events SET received_at=now()-interval '31 days' WHERE project_id=$1",
      [f.project],
    );
    const result = await retainProject(pool, f.project, true, 1000);
    expect(result.removed.events).toBe(24);
  } finally {
    await pool.end();
  }
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Timeline de evidências" }),
  ).toBeVisible();
  await page.locator(".evidence-entry summary").first().click();
  await expect(
    page
      .getByText(
        "Evento original expirou pela retenção. Esta evidência foi preservada.",
      )
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Abrir evento completo" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", {
      name: "Abrir o evento que disparou esta decisão",
    }),
  ).toHaveCount(0);
  await screenshot(page, "m6-retained-evidence");
});

test("response credential, explicit confirmation, real lifecycle and sanitized download", async ({
  page,
  context,
}) => {
  await login(page, "operator");
  await page
    .getByRole("combobox", { name: "Projeto", exact: true })
    .selectOption(f.project);
  await page.getByRole("link", { name: "Integração", exact: true }).click();
  await page
    .getByRole("button", { name: "Criar credencial de resposta", exact: true })
    .click();
  const credential = page.locator(".one-time-key code");
  await expect(credential).toBeVisible();
  const key = await credential.textContent();
  expect(key).toMatch(/^snt_rsp_/);
  await page
    .getByRole("button", { name: "Ocultar credencial", exact: true })
    .click();
  await expect(credential).toHaveCount(0);
  await page.getByRole("link", { name: "Alertas", exact: true }).click();
  await page
    .getByRole("link", { name: "Falhas repetidas de login", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard\/alerts\/[0-9a-f-]{36}\?/);
  const alertId = new URL(page.url()).pathname.split("/").at(-1);
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Falhas repetidas revisadas no laboratorio");
  await page
    .getByRole("combobox", { name: "Duração", exact: true })
    .selectOption("15");
  await page
    .getByRole("button", { name: "Revisar bloqueio", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Cancelar", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Solicitar bloqueio", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Revisar bloqueio", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Solicitar bloqueio", exact: true })
    .click();
  await expect(page.locator(".response-state")).toHaveText(
    "Aguardando aplicação",
  );
  const actionsResponse = await context.request.get(
    `/api${f.base}/alerts/${alertId}/responses`,
  );
  expect(actionsResponse.status()).toBe(200);
  const action = (await actionsResponse.json())[0];
  expect(action).toBeTruthy();
  const confirm = await fetch(
    `${f.api}/v1/response/commands/${action.id}/ack`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: "applied" }),
    },
  );
  expect(confirm.status).toBe(200);
  await expect(page.locator(".response-state")).toHaveText("Aplicado");
  await screenshot(page, "m7-response-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await screenshot(page, "m7-response-mobile");
  const database = createDatabase(process.env.TEST_DATABASE_URL ?? "");
  try {
    await database.pool.query(
      "UPDATE response_actions SET expires_at=now()-interval '1 second' WHERE id=$1",
      [action.id],
    );
  } finally {
    await database.pool.end();
  }
  await expect(page.locator(".response-state")).toHaveText("Prazo encerrado");
  await expect(
    page.getByText(
      "O prazo terminou; a aplicação ainda não confirmou a remoção.",
      { exact: true },
    ),
  ).toBeVisible();
  const expiry = await fetch(`${f.api}/v1/response/commands/${action.id}/ack`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ state: "expired" }),
  });
  expect(expiry.status).toBe(200);
  await expect(
    page.getByText("Remoção confirmada pela aplicação em", { exact: false }),
  ).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Baixar relatório sanitizado", exact: true })
    .click();
  const download = await downloading,
    path = await download.path();
  expect(path).toBeTruthy();
  const raw = await readFile(path ?? "", "utf8"),
    report = JSON.parse(raw);
  expect(report.format).toBe("sentinel.investigation.v1");
  expect(report.evidence.length).toBeGreaterThan(0);
  for (const forbidden of [
    f.project,
    f.org,
    "127.0.0.1",
    key ?? "",
    "Falhas repetidas revisadas no laboratorio",
  ])
    expect(raw).not.toContain(forbidden);
});

test("versioned rule form, conflict feedback, history, reader access and mobile layout", async ({
  page,
  context,
}) => {
  await login(page, "operator");
  await page
    .getByRole("combobox", { name: "Projeto", exact: true })
    .selectOption(f.project);
  await page.getByRole("link", { name: "Regras", exact: true }).click();
  // API rule titles are the original portable definitions; choose the code independently of locale.
  const editor = page.locator(".rule-editor").filter({ hasText: "AUTH-001" });
  await expect(editor).toContainText("v1");
  await editor.getByLabel("Limite de eventos", { exact: true }).fill("8");
  await editor
    .getByRole("button", { name: "Revisar configuração", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Salvar nova versão", exact: true })
    .click();
  await expect(page.locator(".rule-history tbody tr")).toHaveCount(1);
  await expect(
    editor.getByLabel("Limite de eventos", { exact: true }),
  ).toHaveValue("8");
  await screenshot(page, "m7-rules-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await screenshot(page, "m7-rules-mobile");
  // A stale edit must remain visible and require a fresh review.
  const session = await (
    await context.request.get("/api/v1/auth/session")
  ).json();
  const current = await (
      await context.request.get(`/api${f.base}/rule-settings`)
    ).json(),
    rule = current.current.find(
      (item: { code: string }) => item.code === "AUTH-001",
    );
  await editor.getByLabel("Limite de eventos", { exact: true }).fill("9");
  expect(
    (
      await context.request.patch(`/api${f.base}/rule-settings/AUTH-001`, {
        headers: {
          origin: "http://localhost:3300",
          "x-csrf-token": session.csrfToken,
        },
        data: {
          expectedVersion: rule.version,
          enabled: false,
          threshold: 8,
          windowSeconds: rule.windowSeconds,
        },
      })
    ).status(),
  ).toBe(200);
  await editor
    .getByRole("button", { name: "Revisar configuração", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Salvar nova versão", exact: true })
    .click();
  await expect(editor.locator('.form-error[role="alert"]')).toContainText(
    "O recurso mudou ou já existe",
  );
  await page.reload();
  await expect(editor).toContainText("Desativada");
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await login(page, "reader");
  await page
    .getByRole("combobox", { name: "Projeto", exact: true })
    .selectOption(f.project);
  await page.getByRole("link", { name: "Regras", exact: true }).click();
  await expect(
    page.getByLabel("Limite de eventos", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".rule-history tbody tr")).toHaveCount(2);
  await page.getByRole("link", { name: "Alertas", exact: true }).click();
  await page.locator("tbody .row-link").first().click();
  await expect(
    page.getByRole("button", { name: "Revisar bloqueio", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Baixar relatório sanitizado",
      exact: true,
    }),
  ).toBeVisible();
});
