import { proxy } from "../../../lib/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handle = async (
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) => proxy(request, (await context.params).path);

export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
