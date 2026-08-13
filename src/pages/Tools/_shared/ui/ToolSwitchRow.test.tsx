import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolSwitchRow } from "./ToolSwitchRow";

describe("ToolSwitchRow", () => {
  it("renders a full-row label bound to an accessible switch", () => {
    const markup = renderToStaticMarkup(
      <ToolSwitchRow
        id="example-switch"
        testId="example-row"
        label="Example setting"
        hint="Example hint"
        checked
        onCheckedChange={() => undefined}
      />,
    );

    expect(markup).toContain('for="example-switch"');
    expect(markup).toContain('data-testid="example-row"');
    expect(markup).toContain('id="example-switch"');
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain("Example setting");
    expect(markup).toContain("Example hint");
    expect(markup).toContain("cursor-pointer");
  });

  it("forwards the disabled state to the row and switch", () => {
    const markup = renderToStaticMarkup(
      <ToolSwitchRow
        id="disabled-switch"
        label="Disabled setting"
        checked={false}
        disabled
        onCheckedChange={() => undefined}
      />,
    );

    expect(markup).toContain("cursor-not-allowed");
    expect(markup).toContain("opacity-60");
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-checked="false"');
  });
});
