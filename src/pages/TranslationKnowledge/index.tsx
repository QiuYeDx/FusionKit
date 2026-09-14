import { optionKey } from "./labels";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  BookOpen,
  Check,
  Copy,
  Download,
  FileText,
  FolderPlus,
  Import,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ClipPathTabs } from "@/components/qiuye-ui/clip-path-tabs";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";
import { ToolDetailLayout } from "@/pages/Tools/_shared/ui/ToolDetailLayout";
import { ToolPanel } from "@/pages/Tools/_shared/ui/ToolPanel";
import type { Entry } from "@/translation-knowledge/schemas";
import type {
  ImportPreview,
  KnowledgeErrorCode,
  LibrarySnapshot,
  SaveRecordRequest,
} from "@/translation-knowledge/ipc-contract";
import { entrySummary } from "@/translation-knowledge/ipc-contract";
import type { Diagnostic } from "@/translation-knowledge/validation";
import { cn } from "@/lib/utils";
import { Choice, ErrorNotice, KnowledgeDialog, Pagination } from "./Controls";
import {
  CatalogEditor,
  newCatalog,
  type CatalogGroup,
  type CatalogRecord,
} from "./CatalogEditor";
import { EntryEditor } from "./EntryEditor";
import { ExportDialog, ImportDialog, RecordDetails } from "./Exchange";
import {
  entryStatus,
  newEntry,
  filterEntries,
  freshId,
  initialQuery,
  languageKey,
  needsReview,
  PAGE_SIZE,
} from "./model";

type View = "materials" | "plans" | "review";
export default function TranslationKnowledge() {
  const { t } = useTranslation("knowledge");
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<KnowledgeErrorCode | "unexpected" | null>(
    null,
  );
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<View>("materials");
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState(0);
  const [planPage, setPlanPage] = useState(0);
  const [planGroup, setPlanGroup] = useState<
    "recipes" | "styles" | "preferenceTemplates"
  >("recipes");
  const [catalog, setCatalog] = useState<{
    group: CatalogGroup;
    record: CatalogRecord;
  } | null>(null);
  const [entryEditor, setEntryEditor] = useState<Entry | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [detailError, setDetailError] = useState<
    KnowledgeErrorCode | "unexpected" | null
  >(null);
  const [detailDiagnostics, setDetailDiagnostics] = useState<Diagnostic[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const api = window.translationKnowledge;
  const refresh = async () => {
    setLoading(true);
    setError(null);
    setDiagnostics([]);
    try {
      const result = await api.read();
      if (result.ok) setSnapshot(result.value);
      else {
        setError(result.error);
        setDiagnostics(result.diagnostics ?? []);
      }
    } catch {
      setError("unexpected");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    setPage(0);
  }, [query, view]);
  const filtered = useMemo(
    () => (snapshot ? filterEntries(snapshot, query, view === "review") : []),
    [snapshot, query, view],
  );
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1),
  );
  const currentEntry = snapshot?.data.entries.find(
    (item) => item.id === selected,
  );
  const reviewCount =
    snapshot?.data.entries.filter((entry) => needsReview(entry, snapshot))
      .length ?? 0;
  const currentSubject = snapshot?.data.subjects.find(
    (item) => item.id === query.subject,
  );
  const currentCollection = snapshot?.data.collections.find(
    (item) => item.id === query.collection,
  );
  const save = async (request: SaveRecordRequest) => {
    const result = await api.saveRecord(request);
    if (result.ok) {
      setSnapshot(result.value);
      setNotice(t("saved"));
      return result;
    }
    if (result.error === "revision_conflict") void refresh();
    return result;
  };
  const beginImport = async () => {
    setBusy(true);
    setError(null);
    setDiagnostics([]);
    try {
      const result = await api.selectImport();
      if (result.ok) {
        if (result.value) setPreview(result.value);
      } else {
        setError(result.error);
        setDiagnostics(result.diagnostics ?? []);
      }
    } catch {
      setError("unexpected");
    } finally {
      setBusy(false);
    }
  };
  const review = async (action: "adopt" | "reject" | "archive") => {
    if (!snapshot || !currentEntry) return;
    setBusy(true);
    setDetailError(null);
    setDetailDiagnostics([]);
    try {
      const result = await api.reviewEntries({
        generation: snapshot.generation,
        ids: [currentEntry.id],
        action,
      });
      if (result.ok) {
        setSnapshot(result.value);
        setSelected(null);
        setNotice(t(`review.success.${action}`));
      } else {
        setDetailError(result.error);
        setDetailDiagnostics(result.diagnostics ?? []);
      }
    } catch {
      setDetailError("unexpected");
    } finally {
      setBusy(false);
    }
  };
  const startEntry = () => {
    if (!snapshot) return;
    const collection =
      currentCollection ??
      snapshot.data.collections.find((item) => !item.archived);
    if (!collection) {
      setCatalog({ group: "collections", record: newCatalog("collections") });
      setNotice(t("editor.create_collection_first"));
      return;
    }
    setEntryEditor(
      newEntry(collection, currentSubject?.id, snapshot.data.subjects),
    );
  };
  const addCatalog = (group: CatalogGroup) =>
    setCatalog({ group, record: newCatalog(group) });
  const change = (key: keyof typeof query, value: string) =>
    setQuery({ ...query, [key]: value });
  const options = (key: string, values: string[]) =>
    values.map((value) => ({ value, label: t(optionKey(`${key}.${value}`)) }));
  const subjectOptions = [
    { value: "all", label: t("filters.all_subjects") },
    { value: "none", label: t("filters.no_subject") },
    ...(snapshot?.data.subjects ?? []).map((item) => ({
      value: item.id,
      label: `${item.name}${item.archived ? ` · ${t("status.archived")}` : ""}`,
    })),
  ];
  const header = (
    <ToolPageHeader
      meta={TOOL_META.translationKnowledge}
      title={t("title")}
      description={t("description")}
    />
  );
  const aside = (
    <div className="space-y-3">
      <ToolPanel
        title={t("subjects.title")}
        icon={BookOpen}
        actions={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("actions.new_subject")}
            onClick={() => addCatalog("subjects")}
            disabled={!snapshot}
          >
            <Plus />
          </Button>
        }
        bodyClassName="p-3 space-y-4"
      >
        <Choice
          label={t("fields.subject")}
          value={query.subject}
          onChange={(value) => change("subject", value)}
          options={subjectOptions}
        />
        {currentSubject && (
          <div className="space-y-2">
            <p className="break-words text-xs text-muted-foreground">
              {currentSubject.description ||
                t(`subject_kind.${currentSubject.kind}`)}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setCatalog({ group: "subjects", record: currentSubject })
              }
            >
              <Pencil />
              {t("actions.edit_subject")}
            </Button>
          </div>
        )}
        <Choice
          label={t("fields.collection")}
          value={query.collection}
          onChange={(value) => change("collection", value)}
          options={[
            { value: "all", label: t("filters.all_collections") },
            ...(snapshot?.data.collections ?? []).map((item) => ({
              value: item.id,
              label: `${item.name}${item.archived ? ` · ${t("status.archived")}` : ""}`,
            })),
          ]}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!snapshot}
            onClick={() => addCatalog("collections")}
          >
            <FolderPlus />
            {t("actions.new_collection")}
          </Button>
          {currentCollection && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setCatalog({ group: "collections", record: currentCollection })
              }
            >
              <Pencil />
              {t("actions.edit")}
            </Button>
          )}
        </div>
      </ToolPanel>
      <ToolPanel
        title={t("exchange.title")}
        icon={FileText}
        bodyClassName="space-y-3 p-3"
      >
        <p className="text-xs leading-5 text-muted-foreground">
          {t("exchange.help")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="knowledge-import"
            size="sm"
            variant="outline"
            className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left leading-5"
            disabled={busy || !snapshot}
            onClick={() => void beginImport()}
          >
            <Import />
            {t("actions.import")}
          </Button>
          <Button
            data-testid="knowledge-export"
            size="sm"
            variant="outline"
            className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left leading-5"
            disabled={!snapshot || busy}
            onClick={() => setExportOpen(true)}
          >
            <Download />
            {t("actions.export")}
          </Button>
        </div>
      </ToolPanel>
    </div>
  );
  const plans =
    snapshot?.data[planGroup].filter(
      (item) =>
        !query.search.trim() ||
        `${item.name} ${"description" in item ? item.description : item.instructions}`
          .toLocaleLowerCase()
          .includes(query.search.trim().toLocaleLowerCase()),
    ) ?? [];
  const safePlanPage = Math.min(
    planPage,
    Math.max(0, Math.ceil(plans.length / PAGE_SIZE) - 1),
  );
  return (
    <ToolDetailLayout
      header={header}
      aside={aside}
      className="translation-knowledge md:[&>div.grid]:grid-cols-[220px_minmax(0,1fr)] lg:[&>div.grid]:grid-cols-[320px_minmax(0,1fr)]"
      asideClassName="lg:w-full"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ClipPathTabs
          size="sm"
          shape="rounded"
          smoothCorners
          value={view}
          onValueChange={(value) => setView(value as View)}
          ariaLabel={t("views.label")}
          items={[
            { value: "materials", label: t("views.materials") },
            { value: "plans", label: t("views.plans") },
            {
              value: "review",
              label: `${t("views.review")}${reviewCount ? ` (${reviewCount})` : ""}`,
            },
          ]}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("actions.refresh")}
          disabled={loading || busy}
          onClick={() => void refresh()}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>
      <ErrorNotice error={error} diagnostics={diagnostics} />
      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm"
        >
          <p className="break-words">{notice}</p>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("actions.dismiss")}
            onClick={() => setNotice("")}
          >
            <X />
          </Button>
        </div>
      )}
      {loading && !snapshot ? (
        <div
          role="status"
          className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
        >
          <LoaderCircle className="size-4 animate-spin" />
          {t("loading")}
        </div>
      ) : (
        snapshot && (
          <>
            <ToolPanel
              title={t(`views.${view}`)}
              badge={
                <Badge variant="secondary">
                  {view === "plans" ? plans.length : filtered.length}
                </Badge>
              }
              actions={
                <Button
                  data-testid="knowledge-new-entry"
                  size="sm"
                  onClick={() =>
                    view === "plans" ? addCatalog(planGroup) : startEntry()
                  }
                  disabled={busy}
                >
                  <Plus />
                  {t(
                    view === "plans"
                      ? "actions.new_plan_item"
                      : "actions.new_entry",
                  )}
                </Button>
              }
              bodyClassName="min-w-0"
            >
              <div className="space-y-3 border-b p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
                  <Input
                    aria-label={t("filters.search")}
                    placeholder={t("filters.search")}
                    value={query.search}
                    onChange={(event) => {
                      change("search", event.target.value);
                      setPlanPage(0);
                    }}
                    className="h-8 pl-8 text-sm"
                  />
                </div>
                {view === "plans" ? (
                  <>
                    <Choice
                      label={t("plans.category")}
                      value={planGroup}
                      onChange={(value) => {
                        setPlanGroup(value as typeof planGroup);
                        setPlanPage(0);
                      }}
                      options={["recipes", "styles", "preferenceTemplates"].map(
                        (value) => ({
                          value,
                          label: t(optionKey(`group.${value}`)),
                        }),
                      )}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("plans.notice")}
                    </p>
                  </>
                ) : (
                  <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                    <Choice
                      label={t("fields.kind")}
                      value={query.kind}
                      onChange={(value) => change("kind", value)}
                      options={[
                        { value: "all", label: t("filters.all_kinds") },
                        ...options("kind", [
                          "term",
                          "context",
                          "expression",
                          "memory",
                          "rule",
                        ]),
                      ]}
                    />
                    <Choice
                      label={t("fields.language")}
                      value={query.language}
                      onChange={(value) => change("language", value)}
                      options={[
                        { value: "all", label: t("filters.all_languages") },
                        ...[
                          ...new Set(
                            snapshot.data.entries.map((entry) =>
                              languageKey(entry.scope.languagePair),
                            ),
                          ),
                        ]
                          .sort()
                          .map((value) => ({ value, label: value })),
                      ]}
                    />
                    <Choice
                      label={t("fields.status")}
                      value={query.status}
                      onChange={(value) => change("status", value)}
                      options={[
                        { value: "all", label: t("filters.all_statuses") },
                        ...options(
                          "status",
                          view === "review"
                            ? ["candidate", "unconfirmed", "needs_review"]
                            : [
                                "ready",
                                "candidate",
                                "unconfirmed",
                                "needs_review",
                                "rejected",
                                "archived",
                              ],
                        ),
                      ]}
                    />
                  </div>
                )}
              </div>
              {view === "plans" ? (
                <>
                  <div className="space-y-1 p-2">
                    {plans
                      .slice(
                        safePlanPage * PAGE_SIZE,
                        (safePlanPage + 1) * PAGE_SIZE,
                      )
                      .map((item) => (
                        <div
                          key={item.id}
                          className="flex items-start gap-2 rounded-lg p-2 hover:bg-muted/50"
                        >
                          <button
                            className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() =>
                              setCatalog({ group: planGroup, record: item })
                            }
                          >
                            <p className="break-words text-sm font-medium">
                              {item.name}
                              {item.archived && (
                                <span className="ml-2 text-xs font-normal text-muted-foreground">
                                  {t("status.archived")}
                                </span>
                              )}
                            </p>
                            <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                              {"description" in item
                                ? item.description
                                : item.instructions}
                            </p>
                          </button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={t("actions.copy")}
                            onClick={() =>
                              setCatalog({
                                group: planGroup,
                                record: {
                                  ...item,
                                  id: freshId(),
                                  revision: 1,
                                  name: t("copy_name", { name: item.name }),
                                  archived: false,
                                },
                              })
                            }
                          >
                            <Copy />
                          </Button>
                        </div>
                      ))}
                    {!plans.length && (
                      <Empty
                        title={t("empty.plans")}
                        description={t("empty.plans_help")}
                      />
                    )}
                  </div>
                  <Pagination
                    page={safePlanPage}
                    total={plans.length}
                    onChange={setPlanPage}
                  />
                </>
              ) : (
                <>
                  <div className="space-y-1 p-2">
                    {filtered
                      .slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
                      .map((entry) => (
                        <button
                          key={entry.id}
                          data-entry-id={entry.id}
                          onClick={() => {
                            setSelected(entry.id);
                            setDetailError(null);
                          }}
                          className={cn(
                            "block w-full min-w-0 rounded-lg p-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
                            selected === entry.id && "bg-muted",
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <p className="min-w-0 break-words text-sm font-medium">
                              {entry.title}
                            </p>
                            <Badge
                              variant="outline"
                              className="shrink-0 text-[10px]"
                            >
                              {t(`status.${entryStatus(entry, snapshot)}`)}
                            </Badge>
                          </div>
                          <p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">
                            {entrySummary(entry)}
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {t(`kind.${entry.kind}`)} ·{" "}
                            {languageKey(entry.scope.languagePair)} ·{" "}
                            {entry.scope.requiredSubjects.length
                              ? t("scope.limited", {
                                  count: entry.scope.requiredSubjects.length,
                                })
                              : t("scope.general")}
                          </p>
                        </button>
                      ))}
                    {!filtered.length && (
                      <Empty
                        title={t(
                          view === "review"
                            ? "empty.review"
                            : "empty.materials",
                        )}
                        description={t(
                          snapshot.data.entries.length
                            ? "empty.filtered"
                            : "empty.materials_help",
                        )}
                      />
                    )}
                  </div>
                  <Pagination
                    page={safePage}
                    total={filtered.length}
                    onChange={setPage}
                  />
                </>
              )}
            </ToolPanel>
          </>
        )
      )}
      {snapshot && entryEditor && (
        <EntryEditor
          key={entryEditor.id}
          initial={entryEditor}
          snapshot={snapshot}
          onSave={save}
          onClose={() => setEntryEditor(null)}
        />
      )}
      {snapshot && catalog && (
        <CatalogEditor
          key={catalog.record.id}
          group={catalog.group}
          initial={catalog.record}
          snapshot={snapshot}
          onSave={save}
          onClose={() => setCatalog(null)}
        />
      )}
      {preview && (
        <ImportDialog
          preview={preview}
          api={api}
          onClose={() => setPreview(null)}
          onImported={async (message) => {
            setNotice(message);
            await refresh();
          }}
        />
      )}
      {snapshot && exportOpen && (
        <ExportDialog
          snapshot={snapshot}
          api={api}
          initialCollection={currentCollection?.id}
          onClose={() => setExportOpen(false)}
          onExported={setNotice}
        />
      )}
      {snapshot && currentEntry && !entryEditor && (
        <KnowledgeDialog
          title={currentEntry.title}
          description={`${t(`kind.${currentEntry.kind}`)} · ${languageKey(currentEntry.scope.languagePair)} · ${t(`status.${entryStatus(currentEntry, snapshot)}`)}`}
          onClose={() => setSelected(null)}
          pending={busy}
          footer={
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setEntryEditor(currentEntry)}
              >
                <Pencil />
                {t("actions.edit")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setSelected(null);
                  setEntryEditor({
                    ...currentEntry,
                    id: freshId(),
                    revision: 1,
                    state: "candidate",
                    title: t("copy_name", { name: currentEntry.title }),
                  });
                }}
              >
                <Copy />
                {t("actions.copy")}
              </Button>
              {needsReview(currentEntry, snapshot) && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void review("reject")}
                  >
                    {t("actions.reject")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void review("adopt")}
                  >
                    <Check />
                    {t("actions.adopt")}
                  </Button>
                </>
              )}
              {currentEntry.state !== "archived" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void review("archive")}
                >
                  <Archive />
                  {t("actions.archive")}
                </Button>
              )}
            </>
          }
        >
          <p className="whitespace-pre-wrap break-words text-sm leading-6">
            {entrySummary(currentEntry)}
          </p>
          <div className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">
                {t("fields.collection")}:{" "}
              </span>
              {
                snapshot.data.collections.find(
                  (item) => item.id === currentEntry.collectionId,
                )?.name
              }
            </p>
            <p className="text-xs text-muted-foreground">
              {t("detail.revision", { revision: currentEntry.revision })}
            </p>
          </div>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("editor.scope")}</h3>
            {currentEntry.scope.requiredSubjects.length ? (
              <ul className="space-y-1 text-sm">
                {currentEntry.scope.requiredSubjects.map((item) => (
                  <li key={`${item.subjectId}-${item.role}`}>
                    {
                      snapshot.data.subjects.find(
                        (subject) => subject.id === item.subjectId,
                      )?.name
                    }{" "}
                    · {t(`role.${item.role}`)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("scope.general_help")}
              </p>
            )}
            {currentEntry.scope.condition.mode !== "none" && (
              <p className="break-words text-sm">
                {t(`condition.${currentEntry.scope.condition.mode}`)}:{" "}
                {currentEntry.scope.condition.text}
              </p>
            )}
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("detail.sources")}</h3>
            {currentEntry.evidence.map((evidence, index) => {
              const source = snapshot.data.sources.find(
                (item) => item.id === evidence.sourceId,
              );
              return source ? (
                <div key={index} className="space-y-1 rounded-md border p-3">
                  <p className="text-sm font-medium break-words">
                    {source.title}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                    {source.excerpt}
                  </p>
                  {source.url && (
                    <p className="break-all text-xs text-muted-foreground">
                      {source.url}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t(`source.${source.kind}`)} ·{" "}
                    {t(`support.${evidence.support}`)}
                  </p>
                  {evidence.note && (
                    <p className="break-words text-xs">{evidence.note}</p>
                  )}
                </div>
              ) : null;
            })}
          </section>
          <details>
            <summary className="cursor-pointer text-sm">
              {t("detail.all_fields")}
            </summary>
            <div className="mt-3">
              <RecordDetails record={currentEntry} />
            </div>
          </details>
          <ErrorNotice error={detailError} diagnostics={detailDiagnostics} />
        </KnowledgeDialog>
      )}
    </ToolDetailLayout>
  );
}
function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-2 px-3 py-10 text-center">
      <BookOpen className="mx-auto size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto max-w-sm text-xs leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
