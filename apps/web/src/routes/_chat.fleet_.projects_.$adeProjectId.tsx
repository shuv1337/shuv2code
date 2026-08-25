import type { AdeProjectId } from "@shuv2code/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ProjectViewPage } from "../components/fleet/ProjectViewPage";

// `fleet_` and `projects_` both opt out of nesting: the project view is a full
// page, not a layout with an outlet.
export const Route = createFileRoute("/_chat/fleet_/projects_/$adeProjectId")({
  component: ProjectViewRouteView,
});

function ProjectViewRouteView() {
  const { adeProjectId } = Route.useParams();
  return <ProjectViewPage projectId={adeProjectId as AdeProjectId} />;
}
