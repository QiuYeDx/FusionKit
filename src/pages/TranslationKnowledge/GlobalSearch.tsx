import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import type { LibrarySnapshot } from "@/translation-knowledge/ipc-contract";
import type { Entry } from "@/translation-knowledge/schemas";
import { cn } from "@/lib/utils";
import { searchLibrary } from "./model";

function ResultText({ entry }: { entry: Entry }) {
  const { t } = useTranslation("knowledge");
  if (entry.kind === "term") return <span className="flex min-w-0 flex-wrap gap-x-1.5">
    <span className="[overflow-wrap:anywhere]">{entry.payload.source}</span>
    <span aria-hidden className="text-muted-foreground">→</span>
    <span className="[overflow-wrap:anywhere]">{entry.payload.target}</span>
  </span>;
  return <span className="min-w-0">
    <span className="mr-1.5 text-[11px] text-muted-foreground">{t(entry.kind === "rule" ? "notes.rules" : "notes.context")}</span>
    <span className="line-clamp-2 [overflow-wrap:anywhere]">{entry.payload.text}</span>
  </span>;
}

/** Finds wording across every collection; choosing a result opens it in its collection. */
export function GlobalSearch({ snapshot, onSelect, testId = "knowledge-global-search" }: { snapshot: LibrarySnapshot | null; onSelect: (collectionId: string, entryId: string) => void; testId?: string }) {
  const { t } = useTranslation("knowledge");
  const listId = useId();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const result = useMemo(() => snapshot ? searchLibrary(snapshot, query) : { groups: [], total: 0 }, [snapshot, query]);
  const flat = result.groups.flatMap(group => group.entries);
  const open = focused && !!query.trim();
  const choose = (entry: Entry) => { onSelect(entry.collectionId, entry.id); setFocused(false); };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length) setActive(current => (current + (event.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
    } else if (event.key === "Enter" && flat[active]) { event.preventDefault(); choose(flat[active]); }
    else if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); }
  };
  let index = -1;
  return <Popover open={open} onOpenChange={next => { if (!next) setFocused(false); }}>
    <PopoverAnchor asChild>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input data-testid={testId} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={open && flat[active] ? `${listId}-${flat[active].id}` : undefined}
          aria-label={t("search.global")} placeholder={t("search.global")} value={query} disabled={!snapshot}
          onChange={event => { setQuery(event.target.value); setActive(0); setFocused(true); }}
          onFocus={() => setFocused(true)} onKeyDown={keyDown} className="h-8 pl-8 pr-8 text-sm" />
        {query && <button type="button" aria-label={t("search.clear")} onClick={() => setQuery("")}
          className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3.5" /></button>}
      </div>
    </PopoverAnchor>
    <PopoverContent align="start" sideOffset={6} onOpenAutoFocus={event => event.preventDefault()} onInteractOutside={event => { if ((event.target as Element | null)?.closest?.(`[data-testid=${testId}]`)) event.preventDefault(); }}
      className="w-[min(26rem,calc(100vw-2rem))] p-1.5">
      <div id={listId} role="listbox" aria-label={t("search.results")} data-testid="knowledge-search-results" className="max-h-[min(24rem,60vh)] overflow-y-auto overscroll-contain">
        {!flat.length && <p className="px-2.5 py-3 text-xs text-muted-foreground">{t("search.none")}</p>}
        {result.groups.map(group => <div key={group.collection.id} role="group" aria-label={group.collection.name} className="py-0.5">
          <p className="truncate px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{group.collection.name}</p>
          {group.entries.map(entry => { index++; const current = index; return <div key={entry.id} id={`${listId}-${entry.id}`} role="option" aria-selected={current === active}
            data-entry-id={entry.id} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(current)} onClick={() => choose(entry)}
            className={cn("cursor-pointer rounded-md px-2.5 py-1.5 text-[13px] leading-5", current === active && "bg-muted")}><ResultText entry={entry} /></div>; })}
        </div>)}
        {result.total > flat.length && <p className="px-2.5 pb-1.5 pt-1 text-[11px] text-muted-foreground">{t("search.more", { count: result.total - flat.length })}</p>}
      </div>
    </PopoverContent>
  </Popover>;
}
