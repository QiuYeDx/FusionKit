import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PlanWarningsList from "./PlanWarningsList";

describe("PlanWarningsList", () => {
  it("keeps unbroken warning diagnostics inside a shrinkable wrapping surface", () => {
    const warning =
      "model_batch_failed:22:structured_output_failed:No_object_generated:" +
      "x".repeat(240);
    const markup = renderToStaticMarkup(
      <PlanWarningsList
        details={[{ source: "plan", message: warning }]}
        getSourceLabel={() => "Plan-level warning"}
      />
    );

    expect(markup).toContain(warning);
    expect(markup).toContain("min-w-0");
    expect(markup).toContain("max-w-full");
    expect(markup).toContain("overflow-wrap:anywhere");
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain("whitespace-nowrap");
  });

  it("limits the summary list while preserving an explicit remaining count", () => {
    const markup = renderToStaticMarkup(
      <PlanWarningsList
        details={[
          { source: "plan", message: "warning-1" },
          { source: "plan", message: "warning-2" },
        ]}
        getSourceLabel={() => "Plan-level warning"}
        maxVisible={1}
        moreLabel="1 more warning"
      />
    );

    expect(markup).toContain("warning-1");
    expect(markup).not.toContain("warning-2");
    expect(markup).toContain("1 more warning");
  });
});
