import { type ReactNode, Suspense } from "react";
import { Workspace } from "../../components/workspace";
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p className="loading">Carregando workspace…</p>}>
      <Workspace>{children}</Workspace>
    </Suspense>
  );
}
