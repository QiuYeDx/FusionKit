import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, File, FileStack, Folder, Loader2 } from "lucide-react";
import {
  DialogDescription,
  DialogTitle,
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  ScrollableDialogHeader,
} from "@/components/qiuye-ui/scrollable-dialog";
import { Button } from "@/components/ui/button";
import useNameTranslatorStore from "@/store/tools/rename/useNameTranslatorStore";
import { NameText } from "./NameText";

const MAX_LISTED = 400;

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function parentOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

export function ConfirmRenameDialog() {
  const { t } = useTranslation("rename");
  const confirm = useNameTranslatorStore((state) => state.confirm);
  const applying = useNameTranslatorStore((state) => state.applying);
  const store = useNameTranslatorStore.getState;

  const groups = useMemo(() => {
    const result = new Map<string, { path: string; kind: "file" | "directory"; newName: string }[]>();
    for (const item of (confirm?.items ?? []).slice(0, MAX_LISTED)) {
      const parent = parentOf(item.path);
      result.set(parent, [...(result.get(parent) ?? []), item]);
    }
    return [...result.entries()];
  }, [confirm]);

  const files = confirm?.items.filter((item) => item.kind === "file").length ?? 0;
  const folders = (confirm?.items.length ?? 0) - files;

  return (
    <ScrollableDialog
      animateSize
      open={Boolean(confirm)}
      maxWidth="sm:max-w-[620px]"
      onOpenChange={(open) => {
        if (!open) store().cancelConfirm();
      }}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        document.getElementById("name-translator-confirm-cancel")?.focus();
      }}
    >
      <ScrollableDialogHeader className="space-y-1 p-3 pr-12">
        <DialogTitle className="flex items-center gap-2 text-sm">
          <FileStack className="size-4" />
          {t("confirm.title", { count: confirm?.items.length ?? 0 })}
        </DialogTitle>
        <DialogDescription className="text-xs leading-5">
          {t("confirm.summary", { files, folders })}
          {confirm && confirm.skippedCount > 0 ? ` · ${t("confirm.skipped", { count: confirm.skippedCount })}` : ""}
        </DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent className="px-3 py-2">
        <div className="space-y-3" data-testid="name-translator-confirm-list">
          {groups.map(([parent, items]) => (
            <section key={parent} className="min-w-0">
              <div className="mb-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <Folder className="size-3 shrink-0" />
                <NameText name={parent} />
              </div>
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <li
                    key={item.path}
                    className="grid grid-cols-[14px_minmax(0,1fr)_14px_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-muted/50"
                  >
                    {item.kind === "directory" ? (
                      <Folder className="size-3.5 text-sky-600 dark:text-sky-400" />
                    ) : (
                      <File className="size-3.5 text-muted-foreground" />
                    )}
                    <NameText name={baseName(item.path)} className="text-muted-foreground" />
                    <ArrowRight className="size-3.5 text-muted-foreground" />
                    <NameText name={item.newName} className="font-medium" />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {confirm && confirm.items.length > MAX_LISTED ? (
            <p className="px-2 text-xs text-muted-foreground">
              {t("confirm.more", { count: confirm.items.length - MAX_LISTED })}
            </p>
          ) : null}
        </div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="space-y-2 p-3">
        {confirm?.error ? (
          <p role="alert" className="text-xs leading-5 text-destructive [overflow-wrap:anywhere]">
            {confirm.error === "changed" ? t("confirm.changed") : confirm.error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t("confirm.undo_hint")}</p>
          <div className="ml-auto flex gap-2">
            <Button
              id="name-translator-confirm-cancel"
              type="button"
              variant="ghost"
              size="sm"
              disabled={applying}
              onClick={() => store().cancelConfirm()}
            >
              {t("confirm.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="name-translator-confirm"
              disabled={applying || confirm?.error === "changed"}
              onClick={() => void store().confirmRename()}
            >
              {applying ? <Loader2 className="animate-spin" /> : null}
              {applying ? t("confirm.applying") : t("confirm.start")}
            </Button>
          </div>
        </div>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  );
}
