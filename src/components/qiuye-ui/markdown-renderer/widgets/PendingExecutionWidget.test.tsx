import { describe, expect, it } from "vitest";
import { pendingExecutionWidget } from "./PendingExecutionWidget";

describe("pendingExecutionWidget", () => {
  it("accepts only known translation keys from structured widget input", () => {
    expect(
      pendingExecutionWidget.parseProps({
        stores: [
          {
            name: "translate",
            labelKey: "home:store_label_translate",
            count: 2,
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      props: {
        stores: [
          {
            name: "translate",
            labelKey: "home:store_label_translate",
            count: 2,
          },
        ],
      },
    });

    expect(
      pendingExecutionWidget.parseProps({
        stores: [
          {
            name: "unknown",
            labelKey: "home:untrusted_runtime_key",
            count: 1,
          },
        ],
      }),
    ).toEqual({
      ok: false,
      reason: "stores must contain at least one valid item",
    });
  });
});
