import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ConfirmDialog from "./ConfirmDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => `common:${key}` }),
}));

// Radix portals render nothing on the server; the footer labels are what matter here.
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Dialog: Pass, DialogContent: Pass, DialogDescription: Pass, DialogFooter: Pass, DialogHeader: Pass, DialogTitle: Pass };
});

const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(match => match[1]);

describe("ConfirmDialog", () => {
  it("never renders an empty cancel button when the caller omits its labels", () => {
    const markup = renderToStaticMarkup(<ConfirmDialog open onOpenChange={() => {}} title="Clear?" description="Gone." onConfirm={() => {}} />);
    expect(buttons(markup)).toEqual(["common:action.cancel", "common:action.confirm"]);
  });

  it("keeps caller-provided labels", () => {
    const markup = renderToStaticMarkup(<ConfirmDialog open onOpenChange={() => {}} title="Clear?" description="Gone." onConfirm={() => {}} cancelText="Keep" confirmText="Clear" />);
    expect(buttons(markup)).toEqual(["Keep", "Clear"]);
  });
});
