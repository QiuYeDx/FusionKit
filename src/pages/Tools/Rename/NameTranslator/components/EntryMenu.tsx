import { useRef, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FolderSearch,
  Languages,
  ListChecks,
  ListX,
  PencilLine,
  SquareCheck,
  SquareMinus,
  Undo2,
} from "lucide-react";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import useNameTranslatorStore, { type SelectInsideMode } from "@/store/tools/rename/useNameTranslatorStore";

const INSIDE_MODES: readonly SelectInsideMode[] = ["all", "files", "folders", "children", "none"];

function copyText(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/**
 * Actions for one row or a multi-row selection. Shared by the row "more"
 * button and the right-click menu so both always offer the same operations.
 */
function EntryMenuItems({
  getTargets,
  modelReady,
  onEdit,
}: {
  getTargets: () => readonly string[];
  modelReady: boolean;
  onEdit: (path: string) => void;
}) {
  const { t } = useTranslation("rename");
  const entries = useNameTranslatorStore((state) => state.entries);
  const checked = useNameTranslatorStore((state) => state.checked);
  const proposals = useNameTranslatorStore((state) => state.proposals);
  const expanded = useNameTranslatorStore((state) => state.expanded);
  const roots = useNameTranslatorStore((state) => state.roots);
  const run = useNameTranslatorStore((state) => state.run);
  const busy = useNameTranslatorStore((state) => state.applying || state.preparing);
  const store = useNameTranslatorStore.getState;

  // Read when the menu renders (it is only mounted while open).
  const items = getTargets().filter((key) => entries[key]);
  if (items.length === 0) return null;
  const single = items.length === 1 ? items[0]! : null;
  const anyChecked = items.some((key) => checked[key]);
  const allChecked = items.every((key) => checked[key]);
  const anyProposal = items.some((key) => proposals[key]?.stem !== undefined);
  const edited = items.filter((key) => proposals[key]?.edited);
  const folders = items.filter((key) => entries[key]?.kind === "directory" && !entries[key]?.symlink);
  const collapsed = folders.filter((key) => !expanded[key]);
  const open = folders.filter((key) => expanded[key]);
  const rootSet = new Set(roots);

  return (
    <>
      {items.length > 1 ? (
        <>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {t("menu.selected", { count: items.length })}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
        </>
      ) : null}
      {!allChecked ? (
        <DropdownMenuItem disabled={busy} onSelect={() => store().setChecked(items, true)}>
          <SquareCheck />
          {t("menu.check")}
          <DropdownMenuShortcut>Space</DropdownMenuShortcut>
        </DropdownMenuItem>
      ) : null}
      {anyChecked ? (
        <DropdownMenuItem disabled={busy} onSelect={() => store().setChecked(items, false)}>
          <SquareMinus />
          {t("menu.uncheck")}
          {allChecked ? <DropdownMenuShortcut>Space</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        disabled={busy || Boolean(run) || !modelReady}
        onSelect={() => {
          store().setChecked(items, true);
          void store().translate(items);
        }}
      >
        <Languages />
        {anyProposal ? t("menu.retranslate") : t("menu.translate")}
      </DropdownMenuItem>
      {single ? (
        <DropdownMenuItem disabled={busy} onSelect={() => onEdit(single)}>
          <PencilLine />
          {t("menu.edit")}
          <DropdownMenuShortcut>F2</DropdownMenuShortcut>
        </DropdownMenuItem>
      ) : null}
      {edited.length > 0 ? (
        <DropdownMenuItem disabled={busy} onSelect={() => edited.forEach((key) => store().resetName(key))}>
          <Undo2 />
          {t("menu.reset")}
        </DropdownMenuItem>
      ) : null}

      {folders.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={busy}>
              <ListChecks />
              {t("menu.check_inside")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-52">
              {INSIDE_MODES.map((mode) => (
                <DropdownMenuItem
                  key={mode}
                  onSelect={() => folders.forEach((key) => void store().selectInside(key, mode))}
                >
                  {t(`select_inside.${mode}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {collapsed.length > 0 ? (
            <DropdownMenuItem onSelect={() => collapsed.forEach((key) => store().toggleExpanded(key))}>
              <ChevronsUpDown />
              {t("list.expand")}
            </DropdownMenuItem>
          ) : null}
          {open.length > 0 ? (
            <DropdownMenuItem onSelect={() => open.forEach((key) => store().toggleExpanded(key))}>
              <ChevronsDownUp />
              {t("list.collapse")}
            </DropdownMenuItem>
          ) : null}
        </>
      ) : null}

      <DropdownMenuSeparator />
      {single ? (
        <DropdownMenuItem onSelect={() => void window.ipcRenderer?.invoke("show-item-in-folder", single)}>
          <FolderSearch />
          {t("menu.reveal")}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={() => copyText(items.map((key) => entries[key]!.name).join("\n"))}>
        <Copy />
        {t("menu.copy_name")}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => copyText(items.map((key) => entries[key]!.path).join("\n"))}>
        <Copy />
        {t("menu.copy_path")}
      </DropdownMenuItem>
      {items.every((key) => rootSet.has(key)) ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={busy || Boolean(run)} onSelect={() => items.forEach((key) => store().removeRoot(key))}>
            <ListX />
            {t("menu.remove")}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

/**
 * Menu content for row actions. Starting an inline edit keeps focus in the
 * editor instead of letting the closing menu move it back to its trigger
 * (which would blur and commit the editor straight away).
 */
export function EntryMenuContent({
  getTargets,
  modelReady,
  onEdit,
  restoreFocus,
  ...props
}: Omit<ComponentProps<typeof DropdownMenuContent>, "children" | "onCloseAutoFocus"> & {
  /** Rows the actions apply to, read when the menu opens. */
  getTargets: () => readonly string[];
  modelReady: boolean;
  onEdit: (path: string) => void;
  /** Where focus goes when the menu closes; defaults to the menu trigger. */
  restoreFocus?: () => void;
}) {
  const editing = useRef(false);
  return (
    <DropdownMenuContent
      {...props}
      onCloseAutoFocus={(event) => {
        if (editing.current) {
          editing.current = false;
          event.preventDefault();
        } else if (restoreFocus) {
          event.preventDefault();
          restoreFocus();
        }
      }}
    >
      <EntryMenuItems
        getTargets={getTargets}
        modelReady={modelReady}
        onEdit={(path) => {
          editing.current = true;
          onEdit(path);
        }}
      />
    </DropdownMenuContent>
  );
}
