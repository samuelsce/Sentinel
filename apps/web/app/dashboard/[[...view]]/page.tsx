import { notFound } from "next/navigation";
import { IntegrationView } from "../../../components/integration";
import {
  AlertView,
  EventView,
  ListView,
  OverviewView,
} from "../../../components/investigation";
import { RuleSettingsView } from "../../../components/rule-settings";
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ view?: string[] }>;
}) {
  const { view = [] } = await params;
  if (!view.length) return <OverviewView />;
  if (view.length === 1 && view[0] === "rules") return <RuleSettingsView />;
  if (view.length === 1 && (view[0] === "alerts" || view[0] === "events"))
    return <ListView kind={view[0]} />;
  if (view.length === 1 && view[0] === "integration")
    return <IntegrationView />;
  if (view.length === 2 && view[1] && /^[0-9a-f-]{36}$/i.test(view[1])) {
    if (view[0] === "alerts") return <AlertView key={view[1]} id={view[1]} />;
    if (view[0] === "events") return <EventView id={view[1]} />;
  }
  return notFound();
}
