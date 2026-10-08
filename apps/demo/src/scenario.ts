import assert from "node:assert/strict";

export async function runScenario(
  base: string,
  passwords: { reader: string; admin: string },
) {
  const post = async (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3002",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  for (let attempt = 0; attempt < 6; attempt++)
    assert.equal(
      (
        await post("/login", {
          username: "reader",
          password: "intentionally-wrong",
        })
      ).status,
      401,
    );
  const reader = await post("/login", {
    username: "reader",
    password: passwords.reader,
  });
  assert.equal(reader.status, 200);
  const readerBody = (await reader.json()) as { csrfToken: string };
  const readerCookie = reader.headers.get("set-cookie")?.split(";")[0];
  assert.ok(readerCookie);
  for (let attempt = 0; attempt < 10; attempt++)
    assert.equal(
      (
        await post(
          "/admin/settings",
          { enabled: true },
          { cookie: readerCookie, "x-csrf-token": readerBody.csrfToken },
        )
      ).status,
      403,
    );
  for (let attempt = 0; attempt < 3; attempt++)
    assert.equal(
      (
        await post("/login", {
          username: "admin",
          password: "intentionally-wrong",
        })
      ).status,
      401,
    );
  const admin = await post("/login", {
    username: "admin",
    password: passwords.admin,
  });
  assert.equal(admin.status, 200);
  const adminBody = (await admin.json()) as { csrfToken: string };
  const adminCookie = admin.headers.get("set-cookie")?.split(";")[0];
  assert.ok(adminCookie);
  assert.equal(
    (
      await post(
        "/admin/settings",
        { enabled: true },
        { cookie: adminCookie, "x-csrf-token": adminBody.csrfToken },
      )
    ).status,
    200,
  );
  return {
    failedLogins: 9,
    successfulLogins: 2,
    deniedAccesses: 10,
    adminActions: 1,
    totalEvents: 22,
  };
}
