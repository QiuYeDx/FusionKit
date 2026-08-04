import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolRadioButtonGroup } from "./ToolRadioButtonGroup";

describe("ToolRadioButtonGroup", () => {
  it("uses the shared subtitle ButtonGroup and small Button baseline", () => {
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

    expect(markup).toContain('data-slot="button-group"');
    expect(markup.match(/data-slot="button"/g)).toHaveLength(2);
    expect(markup.match(/data-size="sm"/g)).toHaveLength(2);
    expect(markup.match(/min-w-0 flex-1/g)).toHaveLength(2);
    expect(markup).toContain('role="radiogroup"');
    expect(markup.match(/role="radio"/g)).toHaveLength(2);
    expect(markup).toContain('data-variant="default"');
    expect(markup).toContain('data-variant="outline"');
    expect(markup).toContain('data-state="checked"');
    expect(markup).toContain('data-state="unchecked"');
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(1);
  });

  it("supports a vertical radio list without changing the default baseline", () => {
    const markup = renderToStaticMarkup(
      <ToolRadioButtonGroup
        value="first"
        ariaLabel="Tracks"
        orientation="vertical"
        options={[
          { value: "first", label: "First" },
          { value: "second", label: "Second" },
        ]}
        onValueChange={() => undefined}
      />,
    );

    expect(markup).toContain('data-orientation="vertical"');
    expect(markup.match(/justify-start/g)).toHaveLength(2);
    expect(markup.match(/whitespace-normal/g)).toHaveLength(2);
  });
});
