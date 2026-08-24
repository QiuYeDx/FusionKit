import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SegmentedControl } from "./segmented-control";

describe("SegmentedControl", () => {
  it("renders a small accessible radio group with one tab stop", () => {
    const markup = renderToStaticMarkup(
      <SegmentedControl
        size="sm"
        value="second"
        aria-label="Mode"
        items={[
          { value: "first", label: "First" },
          { value: "second", label: "Second" },
          { value: "third", label: "Third", disabled: true },
        ]}
      />,
    );

    expect(markup).toContain('data-slot="segmented-control"');
    expect(markup).toContain('data-size="sm"');
    expect(markup).toContain('role="radiogroup"');
    expect(markup.match(/role="radio"/g)).toHaveLength(3);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(markup).toContain("disabled");
  });

  it("supports full-width vertical groups and item hooks", () => {
    const markup = renderToStaticMarkup(
      <SegmentedControl
        orientation="vertical"
        fullWidth
        defaultValue="first"
        items={[
          { value: "first", label: "First", testId: "first-option" },
          { value: "second", label: "Second" },
        ]}
      />,
    );

    expect(markup).toContain('data-orientation="vertical"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('data-testid="first-option"');
    expect(markup).toContain("w-full");
    expect(markup).toContain("grid-template-columns:minmax(0, 1fr)");
  });
});
