import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackendsView } from "./BackendsView";
import { ComplianceView } from "./ComplianceView";
import { TagsView } from "./TagsView";
import { WorkflowsView } from "./WorkflowsView";
import { PresetsListPage } from "./presets/PresetsListPage";
import { RecipesListPage } from "./recipes/RecipesListPage";
import { StartersListPage } from "./starters/StartersListPage";
import { ContentMerchandisingWorkspace } from "../../features/content-merchandising/ContentMerchandisingWorkspace";
import { JobsView } from "../../features/jobs/JobsView";

describe("admin authority initial states", () => {
  it.each([
    ["jobs", <JobsView key="jobs" />, ["No jobs match the server query.", "Generation Jobs (0)"]],
    ["recipes", <RecipesListPage key="recipes" />, ["No prompt recipes yet."]],
    ["presets", <PresetsListPage key="presets" />, ["No built-in presets are seeded yet."]],
    ["starters", <StartersListPage key="starters" />, ["No starter templates yet."]],
    ["tags", <TagsView key="tags" />, ["No tags.", "Tag taxonomy (0)"]],
    ["workflows", <WorkflowsView key="workflows" />, ["No workflows.", "Workflows (0)"]],
    ["backends", <BackendsView key="backends" />, ["No backends.", "Backends (0)"]],
    ["compliance", <ComplianceView key="compliance" />, ["No records."]],
    [
      "merchandising",
      <ContentMerchandisingWorkspace canWrite={false} key="merchandising" />,
      ["No featured characters", "No characters match these filters"],
    ],
  ])("does not render an empty claim before %s has authoritative data", (_name, view, emptyClaims) => {
    const html = renderToStaticMarkup(view);

    expect(html).toMatch(/Loading|refreshing/);
    for (const emptyClaim of emptyClaims) {
      expect(html).not.toContain(emptyClaim);
    }
  });
});
