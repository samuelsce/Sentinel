const uuid = "[0-9a-fA-F-]{36}";
const project = `/v1/organizations/${uuid}/projects/${uuid}`;
const allowed: Record<string, RegExp[]> = {
  GET: [
    /^\/v1\/auth\/session$/,
    /^\/v1\/organizations$/,
    new RegExp(`^/v1/organizations/${uuid}/projects$`),
    new RegExp(
      `^${project}(?:/(?:overview|stream|metrics|rules|rule-settings|response-keys|jobs|keys|events|alerts))?$`,
    ),
    new RegExp(
      `^${project}/(?:events/${uuid}|alerts/${uuid}(?:/(?:evidence|responses|report))?)$`,
    ),
  ],
  POST: [
    /^\/v1\/auth\/(?:login|logout)$/,
    new RegExp(`^/v1/organizations/${uuid}/projects$`),
    new RegExp(`^${project}/keys$`),
    new RegExp(`^${project}/response-keys$`),
    new RegExp(`^${project}/alerts/${uuid}/responses$`),
  ],
  PATCH: [
    new RegExp(`^${project}/alerts/${uuid}$`),
    new RegExp(`^${project}/rule-settings/(?:AUTH-001|AUTHZ-001|ADMIN-001)$`),
  ],
  DELETE: [new RegExp(`^${project}/(?:keys|response-keys)/${uuid}$`)],
};

// Fixed upstream, explicit routes and headers: never act as an arbitrary HTTP proxy.
export async function proxy(
  request: Request,
  path: string[],
  upstream = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3001",
  transport: typeof fetch = fetch,
): Promise<Response> {
  const route = `/${path.join("/")}`;
  const fail = (status: number) =>
    Response.json(
      { message: "Invalid request" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  if (!allowed[request.method]?.some((pattern) => pattern.test(route)))
    return fail(404);
  const headers = new Headers();
  for (const name of [
    "cookie",
    "origin",
    "sec-fetch-site",
    "x-csrf-token",
    "content-type",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let body: string | undefined;
  if (!["GET", "HEAD"].includes(request.method)) {
    if (Number(request.headers.get("content-length") ?? 0) > 8192)
      return fail(413);
    const reader = request.body?.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          return fail(413);
        }
        chunks.push(chunk.value);
      }
    body = Buffer.concat(chunks).toString("utf8");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 10_000);
  try {
    const response = await transport(
      `${upstream}${route}${new URL(request.url).search}`,
      {
        method: request.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
      },
    );
    const output = new Headers({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    for (const name of [
      "content-type",
      "content-disposition",
      "retry-after",
      "x-accel-buffering",
    ]) {
      const value = response.headers.get(name);
      if (value) output.set(name, value);
    }
    for (const cookie of response.headers.getSetCookie())
      output.append("set-cookie", cookie);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return fail(502);
    }
    clearTimeout(timeout);
    // Stream cancellation aborts the upstream socket, freeing its SSE slot.
    const incoming = response.body?.getReader();
    const stream = incoming
      ? new ReadableStream<Uint8Array>({
          async pull(target) {
            try {
              const next = await incoming.read();
              if (next.done) {
                target.close();
                request.signal.removeEventListener("abort", abort);
              } else target.enqueue(next.value);
            } catch {
              target.error(new Error("Upstream unavailable"));
              controller.abort();
              request.signal.removeEventListener("abort", abort);
            }
          },
          async cancel() {
            controller.abort();
            await incoming.cancel().catch(() => {});
            request.signal.removeEventListener("abort", abort);
          },
        })
      : null;
    if (!incoming) request.signal.removeEventListener("abort", abort);
    return new Response(stream, { status: response.status, headers: output });
  } catch {
    request.signal.removeEventListener("abort", abort);
    return fail(503);
  } finally {
    clearTimeout(timeout);
  }
}
