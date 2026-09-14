import { optionKey, protocolKey, diagnosticKey } from "./labels";
import { useState } from "react";
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
}: {
  preview: ImportPreview;
  api: TranslationKnowledgeApi;
  onClose: () => void;
  onImported: (message: string) => Promise<void>;
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
    if (pending) return;
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
        <Button size="sm" disabled={pending} onClick={() => void submit()}>
          {t(pending ? "actions.importing" : "actions.confirm_import")}
        </Button>
      }
    >
      <p className="text-sm">{t("import.counts", preview.counts)}</p>
      <p className="text-xs text-muted-foreground">{t("import.trust_help")}</p>
      {preview.warnings.length > 0 && (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm">
            {t("import.warnings", { count: preview.warnings.length })}
          </summary>
          <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted-foreground">
            {preview.warnings.map((warning, index) => (
              <li key={index}>
                {t(diagnosticKey(`diagnostic.${warning.code}`))}
              </li>
            ))}
          </ul>
        </details>
      )}
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
                  disabled={pending}
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
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t(
                  item.status === "conflict"
                    ? "import.differences"
                    : "import.contents",
                )}
              </summary>
              <div className="mt-3 max-h-72 overflow-y-auto rounded-md bg-muted/30 p-3">
                <RecordDetails
                  record={item.incoming}
                  changedFrom={
                    item.status === "conflict" ? item.local : undefined
                  }
                />
              </div>
            </details>
          </div>
        ))}
      </div>
      <Pagination page={page} total={ordered.length} onChange={setPage} />
      {ready > 0 && (
        <Check
          label={t("import.adopt_ready", { count: ready })}
          checked={adoptReady}
          disabled={pending}
          onChange={setAdoptReady}
        />
      )}
      <ErrorNotice error={error} diagnostics={diagnostics} />
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
  const [purpose, setPurpose] = useState<"share" | "backup">("share");
  const [collections, setCollections] = useState<string[]>(
    initialCollection ? [initialCollection] : [],
  );
  const [memories, setMemories] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<KnowledgeErrorCode | "unexpected" | null>(
    null,
  );
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const submit = async () => {
    if (pending) return;
    setDiagnostics([]);
    setPending(true);
    setError(null);
    try {
      const result = await api.exportFile({
        generation: snapshot.generation,
        purpose,
        collectionIds: purpose === "backup" ? [] : collections,
        includeMemories: purpose === "backup" || memories,
      });
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
  return (
    <KnowledgeDialog
      title={t("export.title")}
      description={t("export.description")}
      pending={pending}
      onClose={onClose}
      footer={
        <Button
          size="sm"
          disabled={pending || (purpose === "share" && !collections.length)}
          onClick={() => void submit()}
        >
          {t(pending ? "actions.exporting" : "actions.choose_save")}
        </Button>
      }
    >
      <fieldset disabled={pending} className="space-y-4">
        <Choice
          label={t("export.purpose")}
          value={purpose}
          onChange={(value) => setPurpose(value as "share" | "backup")}
          options={["share", "backup"].map((value) => ({
            value,
            label: t(optionKey(`export.${value}`)),
          }))}
        />
        <p className="text-xs text-muted-foreground">
          {t(`export.${purpose}_help`)}
        </p>
        {purpose === "share" && (
          <MultiChoice
            label={t("fields.collections")}
            options={snapshot.data.collections.filter((item) => !item.archived)}
            value={collections}
            onChange={setCollections}
          />
        )}
        {purpose === "share" && (
          <Check
            label={t("export.memories")}
            checked={memories}
            onChange={setMemories}
          />
        )}
        <p className="text-xs text-muted-foreground">
          {t(
            purpose === "share"
              ? "export.memories_help"
              : "export.backup_memories",
          )}
        </p>
      </fieldset>
      <ErrorNotice error={error} diagnostics={diagnostics} />
    </KnowledgeDialog>
  );
}
