import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolSwitchRow, ToolToggleRow } from "./ToolSwitchRow";

describe("ToolSwitchRow", () => {
  it("keeps a checkbox row's additional controls outside its label", () => {
    const markup = renderToStaticMarkup(
      <ToolToggleRow id="subject" label="Subject" control="checkbox" checked disabled onCheckedChange={() => undefined}>
        <select aria-label="Role"><option>Topic</option></select>
      </ToolToggleRow>,
    );
    expect(markup).toContain('for="subject"');
    expect(markup).toContain('role="checkbox"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).not.toContain('role="switch"');
    expect(markup.slice(0, markup.indexOf('</label>'))).toContain('disabled');
    expect(markup.indexOf('<select')).toBeGreaterThan(markup.indexOf('</label>'));
  });

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
