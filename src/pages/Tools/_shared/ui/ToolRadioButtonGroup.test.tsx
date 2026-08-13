import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolRadioButtonGroup } from "./ToolRadioButtonGroup";

describe("ToolRadioButtonGroup", () => {
  it("uses the shared small segmented control baseline", () => {
    const markup = renderToStaticMarkup(
      <ToolRadioButtonGroup
        value="first"
        ariaLabel="Mode"
        options={[
          { value: "first", label: "First" },
          { value: "second", label: "Second" },
        ]}
        onValueChange={() => undefined}
      />,
    );

    expect(markup).toContain('data-slot="segmented-control"');
    expect(markup).toContain('data-size="sm"');
    expect(markup).toContain('data-variant="floating"');
    expect(markup).toContain('data-orientation="horizontal"');
    expect(markup.match(/data-slot="segmented-control-item"/g)).toHaveLength(2);
    expect(markup).toContain('role="radiogroup"');
    expect(markup.match(/role="radio"/g)).toHaveLength(2);
    expect(markup).toContain('data-state="active"');
    expect(markup).toContain('data-state="inactive"');
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(1);
  });

  it("supports a vertical radio list and stable item test ids", () => {
    const markup = renderToStaticMarkup(
      <ToolRadioButtonGroup
        value="first"
        ariaLabel="Tracks"
        orientation="vertical"
        options={[
          { value: "first", label: "First", testId: "first-track" },
          { value: "second", label: "Second" },
        ]}
        onValueChange={() => undefined}
      />,
    );

    expect(markup).toContain('data-orientation="vertical"');
    expect(markup).toContain('data-testid="first-track"');
    expect(markup.match(/justify-start/g)).toHaveLength(2);
    expect(markup).toContain("whitespace-normal");
    expect(markup).toContain('data-slot="segmented-control-label"');
  });
});
