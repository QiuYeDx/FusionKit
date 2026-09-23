import { KnowledgeDisclosure } from "./KnowledgeDisclosure";
import { DialogTransition } from "@/components/qiuye-ui/dialog-motion";
import type {
  ExportPreview,
  ExportSelectionRequest,
} from "@/translation-knowledge/export-contract";
import { optionKey, protocolKey, diagnosticKey } from "./labels";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type {
  ImportPreview,
  KnowledgeErrorCode,
  LibrarySnapshot,
  TranslationKnowledgeApi,
  KnowledgeEntity,
} from "@/translation-knowledge/ipc-contract";
import type { Diagnostic } from "@/translation-knowledge/validation";
import {
  Choice,
  Check,
  ErrorNotice,
  KnowledgeDialog,
  MultiChoice,
  Pagination,
} from "./Controls";
import {
  defaultImportDecisions,
  importActions,
  PAGE_SIZE,
  recordFields,
  exportPreviewCurrent,
} from "./model";

export function RecordDetails({
  record,
  changedFrom,
}: {
  record: KnowledgeEntity;
  changedFrom?: KnowledgeEntity;
}) {
  const { t } = useTranslation("knowledge");
  const fields = recordFields(record);
  const old = changedFrom ? recordFields(changedFrom) : {};
  const keys = [
    ...new Set([...Object.keys(fields), ...Object.keys(old)]),
  ].filter((key) => !changedFrom || fields[key] !== old[key]);
  const label = (key: string) =>
    key
      .split(".")
      .map((part) =>
        /^\d+$/.test(part) ? part : t(protocolKey(`protocol.${part}`)),
      )
      .join(" / ");
  return (
    <dl className="space-y-2 text-xs">
      {keys.length ? (
        keys.map((key) => (
          <div
            key={key}
            className="grid gap-1 border-b pb-2 last:border-0 last:pb-0"
          >
            <dt className="font-medium text-muted-foreground break-words">
              {label(key)}
            </dt>
            {changedFrom && (
              <dd className="break-words whitespace-pre-wrap text-muted-foreground">
                {t("import.local")}: {old[key] ?? "—"}
              </dd>
            )}
            <dd className="break-words whitespace-pre-wrap">
              {changedFrom && `${t("import.incoming")}: `}
              {fields[key] ?? "—"}
            </dd>
          </div>
        ))
      ) : (
        <p className="text-muted-foreground">{t("import.no_difference")}</p>
      )}
    </dl>
  );
}
export function ImportDialog({
  preview,
  api,
  onClose,
  onImported,
  blocked = false,
}: {
  preview: ImportPreview;
  api: TranslationKnowledgeApi;
  onClose: () => void;
  onImported: (message: string) => Promise<void>;
  blocked?: boolean;
}) {
  const { t } = useTranslation("knowledge");
  const [decisions, setDecisions] = useState(() =>
    defaultImportDecisions(preview.items),
  );
  const [adoptReady, setAdoptReady] = useState(false);
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<KnowledgeErrorCode | "unexpected" | null>(
    null,
  );
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const ready = preview.items.filter(
    (item) =>
      item.group === "entries" &&
      "state" in item.incoming &&
      item.incoming.state === "ready",
  ).length;
  const ordered = [...preview.items].sort(
    (a, b) => Number(b.status === "conflict") - Number(a.status === "conflict"),
  );
  const submit = async () => {
    if (pending || blocked) return;
    setPending(true);
    setError(null);
    try {
      const result = await api.commitImport({
        planId: preview.planId,
        decisions,
        adoptReady,
      });
      if (!result.ok) {
        setError(result.error);
        setDiagnostics(result.diagnostics ?? []);
        return;
      }
      await onImported(t("import.success", { ...result.value }));
      onClose();
    } catch {
      setError("unexpected");
    } finally {
      setPending(false);
    }
  };
  return (
    <KnowledgeDialog
      title={t("import.title")}
      description={preview.packageName}
      wide
      pending={pending}
      onClose={onClose}
      footer={
        <Button
          size="sm"
          disabled={pending || blocked}
          onClick={() => void submit()}
        >
          {t(pending ? "actions.importing" : "actions.confirm_import")}
        </Button>
      }
    >
      <div><div className="space-y-4">
      <p className="text-sm">{t("import.counts", preview.counts)}</p>
      <p className="text-xs text-muted-foreground">{t("import.trust_help")}</p>
      {preview.warnings.length > 0 && (
        <KnowledgeDisclosure title={t("import.warnings", { count: preview.warnings.length })}>
          <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
            {preview.warnings.map((warning, index) => (
              <li key={index}>
                {t(diagnosticKey(`diagnostic.${warning.code}`))}
              </li>
            ))}
          </ul>
        </KnowledgeDisclosure>
      )}
      <DialogTransition transitionKey={page}>
      <div className="space-y-2">
        {ordered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item) => (
          <div key={item.id} className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{item.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(`group.${item.group}`)} ·{" "}
                  {t(`import.status.${item.status}`)}
                  {"state" in item.incoming &&
                    ` · ${t(item.incoming.state === "ready" ? "import.declared_ready" : `status.${item.incoming.state}`)}`}
                </p>
              </div>
              <div className="w-40 shrink-0">
                <Choice
                  label={t("import.decision")}
                  value={
                    decisions.find((decision) => decision.id === item.id)
                      ?.action ?? "keep"
                  }
                  disabled={pending || blocked}
                  options={importActions(item).map((value) => ({
                    value,
                    label: t(
                      value === "replace" && item.status === "new"
                        ? "import.action.add"
                        : `import.action.${value}`,
                    ),
                  }))}
                  onChange={(action) =>
                    setDecisions(
                      decisions.map((decision) =>
                        decision.id === item.id
                          ? {
                              ...decision,
                              action: action as typeof decision.action,
                            }
                          : decision,
                      ),
                    )
                  }
                />
              </div>
            </div>
            {item.sameRevision && item.status === "conflict" && (
              <p className="text-xs text-muted-foreground">
                {t("import.same_revision")}
              </p>
            )}
            <KnowledgeDisclosure variant="inline" title={t(
                  item.status === "conflict"
                    ? "import.differences"
                    : "import.contents",
                )}>
              <div className="max-h-72 overflow-y-auto rounded-md bg-muted/30 p-3">
                <RecordDetails
                  record={item.incoming}
                  changedFrom={
                    item.status === "conflict" ? item.local : undefined
                  }
                />
              </div>
            </KnowledgeDisclosure>
          </div>
        ))}
      </div>
      </DialogTransition>
      <Pagination page={page} total={ordered.length} onChange={setPage} />
      {ready > 0 && (
        <Check
          label={t("import.adopt_ready", { count: ready })}
          checked={adoptReady}
          disabled={pending || blocked}
          onChange={setAdoptReady}
        />
      )}
      </div>
      <ErrorNotice error={error} diagnostics={diagnostics} stageClassName="pt-4" />
      </div>
    </KnowledgeDialog>
  );
}
export function ExportDialog({
  snapshot,
  api,
  onClose,
  onExported,
  initialCollection,
}: {
  snapshot: LibrarySnapshot;
  api: TranslationKnowledgeApi;
  onClose: () => void;
  onExported: (message: string) => void;
  initialCollection?: string;
}) {
  const { t } = useTranslation("knowledge");
  const [selection, setSelection] = useState<ExportSelectionRequest>({
    generation: snapshot.generation,
    purpose: "share",
    collectionIds: initialCollection ? [initialCollection] : [],
    recipeIds: [],
    includeMemories: false,
    includeUnreviewed: false,
    includeInactive: false,
    excludedSourceIds: [],
  });
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<KnowledgeErrorCode | "unexpected" | null>(
    null,
  );
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [sourcePage, setSourcePage] = useState(0);
  const [memoryPage, setMemoryPage] = useState(0);
  const blocked = snapshot.maintenance?.cleanupPending === true;
  const current = exportPreviewCurrent(preview, snapshot.generation);
  const update = (patch: Partial<ExportSelectionRequest>) => {
    setSelection((previous) => ({ ...previous, ...patch }));
    setPreview(null);
    setError(null);
    setDiagnostics([]);
    setSourcePage(0);
    setMemoryPage(0);
  };
  useEffect(() => {
    setPreview(null);
    setSelection((previous) => ({
      ...previous,
      generation: snapshot.generation,
    }));
  }, [snapshot.generation]);
  const plan = async () => {
    if (pending || blocked) return;
    setPending(true);
    setError(null);
    setDiagnostics([]);
    try {
      const request =
        selection.purpose === "backup"
          ? {
              ...selection,
              generation: snapshot.generation,
              collectionIds: [],
              recipeIds: [],
              includeMemories: true,
              includeUnreviewed: true,
              includeInactive: true,
              excludedSourceIds: [],
            }
          : { ...selection, generation: snapshot.generation };
      const result = await api.planExport(request);
      if (result.ok) {
        setPreview(result.value);
        setSourcePage(0);
        setMemoryPage(0);
      } else {
        setError(result.error);
        setDiagnostics(result.diagnostics ?? []);
      }
    } catch {
      setError("unexpected");
    } finally {
      setPending(false);
    }
  };
  const save = async () => {
    if (!preview || !current || !preview.canExport || blocked || pending)
      return;
    setPending(true);
    setError(null);
    setDiagnostics([]);
    try {
      const result = await api.exportFile({ planId: preview.planId });
      if (!result.ok) {
        setError(result.error);
        setDiagnostics(result.diagnostics ?? []);
        return;
      }
      if (result.value) {
        onExported(
          t("export.success", {
            name: result.value.fileName,
            count: result.value.entries,
          }),
        );
        onClose();
      }
    } catch {
      setError("unexpected");
    } finally {
      setPending(false);
    }
  };
  const names = new Map(
    Object.values(snapshot.data)
      .filter(Array.isArray)
      .flat()
      .filter(
        (item): item is { id: string; name?: string; title?: string } =>
          !!item && typeof item === "object" && "id" in item,
      )
      .map((item) => [item.id, item.name ?? item.title ?? ""]),
  );
  return (
    <KnowledgeDialog
      title={t("export.title")}
      description={t("export.preview_workflow")}
      wide
      pending={pending}
      onClose={onClose}
      footer={
        <>
          <Button
            data-testid="knowledge-export-preview"
            size="sm"
            variant="outline"
            disabled={
              pending ||
              blocked ||
              (selection.purpose === "share" &&
                !selection.collectionIds.length &&
                !selection.recipeIds.length)
            }
            onClick={() => void plan()}
          >
            {t(pending ? "export.preparing" : "export.preview_action")}
          </Button>
          <Button
            data-testid="knowledge-export-save"
            size="sm"
            disabled={pending || blocked || !current || !preview?.canExport}
            onClick={() => void save()}
          >
            {t("actions.choose_save")}
          </Button>
        </>
      }
    >
      <div>
      <fieldset disabled={pending || blocked} className="space-y-4">
        <Choice
          label={t("export.purpose")}
          value={selection.purpose}
          onChange={(value) => update({ purpose: value as "share" | "backup" })}
          options={(["share", "backup"] as const).map((value) => ({
            value,
            label: t(`export.${value}`),
          }))}
        />
        <div>
        <p className="text-xs text-muted-foreground">
          {t(`export.${selection.purpose}_help`)}
        </p>
        <DialogTransition transitionKey={selection.purpose} stageClassName="pt-4">{selection.purpose === "share" && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <MultiChoice
                label={t("fields.collections")}
                options={snapshot.data.collections.filter(
                  (item) => selection.includeInactive || !item.archived,
                )}
                value={selection.collectionIds}
                onChange={(collectionIds) => update({ collectionIds })}
              />
              <MultiChoice
                label={t("export.recipes")}
                options={snapshot.data.recipes.filter(
                  (item) => selection.includeInactive || !item.archived,
                )}
                value={selection.recipeIds}
                onChange={(recipeIds) => update({ recipeIds })}
              />
            </div>
            <Check
              label={t("export.memories")}
              checked={selection.includeMemories}
              onChange={(includeMemories) => update({ includeMemories })}
            />
            <Check
              label={t("export.unreviewed")}
              checked={selection.includeUnreviewed}
              onChange={(includeUnreviewed) => update({ includeUnreviewed })}
            />
            <Check
              label={t("export.inactive")}
              checked={selection.includeInactive}
              onChange={(includeInactive) => update({ includeInactive })}
            />
            <KnowledgeDisclosure title={t("export.exclude_sources")}>
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {t("export.exclude_sources_help")}
                </p>
                <MultiChoice
                  label={t("export.excluded_sources")}
                  options={snapshot.data.sources.map((source) => ({
                    id: source.id,
                    name: source.title,
                  }))}
                  value={selection.excludedSourceIds}
                  onChange={(excludedSourceIds) =>
                    update({ excludedSourceIds })
                  }
                />
              </div>
            </KnowledgeDisclosure>
          </div>
        )}</DialogTransition>
        </div>
      </fieldset>
      <DialogTransition transitionKey={preview && current ? preview.planId : preview ? 'expired' : 'unplanned'} stageClassName="pt-4">
      {preview && current && (
        <section
          className="border-t pt-4"
          data-testid="knowledge-export-preview-content"
        >
          <div className="space-y-4">
          <h3 className="text-sm font-semibold">
            {t("export.preview_title", {
              count: preview.counts.entries,
              bytes: preview.bytes.toLocaleString(),
            })}
          </h3>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {(
              Object.keys(preview.counts) as (keyof typeof preview.counts)[]
            ).map((group) => (
              <span key={group}>
                {t(`group.${group}`)}: {preview.counts[group]}
              </span>
            ))}
          </div>
          <section className="space-y-2">
            <h4 className="text-sm font-medium">
              {t("export.collection_impacts")}
            </h4>
            {preview.collectionImpacts.map((collection) => (
              <div key={collection.id} className="rounded-md border p-3">
                <p className="break-words text-sm font-medium">
                  {collection.name}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(
                    preview.purpose === "backup"
                      ? "export.backup_collection"
                      : collection.destinationOnly
                        ? "export.destination_only"
                        : collection.explicit
                          ? "export.selected_collection"
                          : "export.dependency_collection",
                  )}{" "}
                  ·{" "}
                  {t("export.entry_counts", {
                    included: collection.includedEntries,
                    excluded: collection.excludedEntries,
                  })}
                </p>
                {collection.viaIds.length > 0 && (
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {t("export.required_by", {
                      names: collection.viaIds
                        .map(
                          (id) => names.get(id) || t("export.related_record"),
                        )
                        .join(" / "),
                    })}
                  </p>
                )}
              </div>
            ))}
          </section>
          <KnowledgeDisclosure title={t("export.dependencies")}>
            <div className="space-y-2">
              {preview.included
                .filter(
                  (item) =>
                    item.group !== "entries" && item.group !== "sources",
                )
                .map((item) => (
                  <p key={item.id} className="break-words text-xs">
                    {item.title} · {t(`group.${item.group}`)} ·{" "}
                    {t(`export.reason.${item.reason}`)}
                  </p>
                ))}
            </div>
          </KnowledgeDisclosure>
          <section className="space-y-2">
            <h4 className="text-sm font-medium">
              {t("export.sources_preview", {
                count: preview.sourceExcerpts.length,
              })}
            </h4>
            <DialogTransition transitionKey={sourcePage}><div className="space-y-2">{preview.sourceExcerpts
              .slice(sourcePage * PAGE_SIZE, (sourcePage + 1) * PAGE_SIZE)
              .map((source) => (
                <div key={source.id} className="space-y-2 rounded-md border p-3">
                  <p className="break-words text-sm font-medium">
                    {source.title}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                    {source.excerpt}
                  </p>
                  {source.attribution && (
                    <p className="break-words text-xs">{source.attribution}</p>
                  )}
                  {selection.purpose === "share" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        update({
                          excludedSourceIds: [
                            ...selection.excludedSourceIds,
                            source.id,
                          ],
                        })
                      }
                    >
                      {t("export.exclude_this_source")}
                    </Button>
                  )}
                </div>
              ))}</div></DialogTransition>
            <Pagination
              page={sourcePage}
              total={preview.sourceExcerpts.length}
              onChange={setSourcePage}
            />
          </section>
          <section className="space-y-2">
            <h4 className="text-sm font-medium">
              {t("export.memories_preview", {
                count: preview.memoryExcerpts.length,
              })}
            </h4>
            <DialogTransition transitionKey={memoryPage}><div className="space-y-2">{preview.memoryExcerpts
              .slice(memoryPage * PAGE_SIZE, (memoryPage + 1) * PAGE_SIZE)
              .map((memory) => (
                <div
                  key={memory.id}
                  className="space-y-2 rounded-md border p-3"
                >
                  <p className="break-words text-sm font-medium">
                    {memory.title}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-xs">
                    {memory.source}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {memory.target}
                  </p>
                </div>
              ))}</div></DialogTransition>
            <Pagination
              page={memoryPage}
              total={preview.memoryExcerpts.length}
              onChange={setMemoryPage}
            />
          </section>
          {preview.excluded.length > 0 && (
            <KnowledgeDisclosure title={t("export.excluded_count", { count: preview.excluded.length })}>
              <ul className="max-h-48 space-y-2 overflow-y-auto text-xs">
                {preview.excluded.map((item) => (
                  <li key={item.id} className="break-words">
                    {item.title} · {t(`export.excluded_reason.${item.reason}`)}
                  </li>
                ))}
              </ul>
            </KnowledgeDisclosure>
          )}
          </div>
          <ErrorNotice
            error={preview.errors.length ? "invalid_input" : null}
            diagnostics={preview.errors}
            stageClassName="pt-4"
          />
          {preview.warnings.length > 0 && (
            <div className="pt-4">
            <KnowledgeDisclosure title={t("import.warnings", { count: preview.warnings.length })}>
              <ul className="space-y-2 text-xs">
                {preview.warnings.map((warning, index) => (
                  <li key={index}>
                    <p>{t(diagnosticKey(`diagnostic.${warning.code}`))}</p>
                    <p className="break-all text-muted-foreground">
                      {warning.path} · {warning.message}
                    </p>
                  </li>
                ))}
              </ul>
            </KnowledgeDisclosure>
            </div>
          )}
        </section>
      )}
      {!preview && (
        <p className="text-xs text-muted-foreground">
          {t("export.preview_required")}
        </p>
      )}
      </DialogTransition>
      <ErrorNotice
        error={preview && !current ? "plan_expired" : error}
        diagnostics={diagnostics}
        stageClassName="pt-4"
      />
      </div>
    </KnowledgeDialog>
  );
}
