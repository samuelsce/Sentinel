import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

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
    "O alerta mudou em outra sessão",
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
