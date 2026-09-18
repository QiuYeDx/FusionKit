import type { MaintenancePreview } from "@/translation-knowledge/maintenance-contract";
import { optionKey, type FieldName } from "./labels";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type {
  Collection,
  PreferenceTemplate,
  Recipe,
  Style,
  Subject,
} from "@/translation-knowledge/schemas";
import type {
  EntityGroup,
  KnowledgeErrorCode,
  KnowledgeResult,
  LibrarySnapshot,
  SaveRecordRequest,
} from "@/translation-knowledge/ipc-contract";
import {
  Choice,
  Check,
  LinesField,
  LanguageField,
  ErrorNotice,
  KnowledgeDialog,
  MultiChoice,
  TextField,
} from "./Controls";
import type { Diagnostic } from "@/translation-knowledge/validation";
import { freshId, splitLines } from "./model";
export type CatalogRecord =
  | Subject
  | Collection
  | Style
  | Recipe
  | PreferenceTemplate;
export type CatalogGroup = Exclude<EntityGroup, "sources" | "entries">;
export function newCatalog(group: CatalogGroup): CatalogRecord {
  const base = {
    id: freshId(),
    revision: 1,
    archived: false,
    name: "",
    description: "",
  };
  switch (group) {
    case "subjects":
      return { ...base, kind: "work", aliases: [], tags: [] };
    case "collections":
      return {
        ...base,
        aboutSubjectIds: [],
        defaultLanguagePair: { source: "ja", target: "zh-Hans" },
      };
    case "styles":
      return {
        ...base,
        languagePair: { source: "ja", target: "zh-Hans" },
        ruleEntryIds: [],
      };
    case "recipes":
      return {
        ...base,
        languagePair: { source: "ja", target: "zh-Hans" },
        readCollectionIds: [],
        subjectSuggestions: [],
        modifierStyleIds: [],
        instructions: "",
        context: "",
        inheritGlobalPreferences: false,
        learningSuggestion: "off",
      };
    case "preferenceTemplates":
      return {
        id: base.id,
        revision: 1,
        archived: false,
        name: "",
        instructions: "",
      };
  }
}
export function CatalogEditor({
  group,
  initial,
  snapshot,
  onSave,
  onClose,
  onMaintenance,
  blocked = false,
}: {
  group: CatalogGroup;
  initial: CatalogRecord;
  snapshot: LibrarySnapshot;
  onSave: (
    request: SaveRecordRequest,
  ) => Promise<KnowledgeResult<LibrarySnapshot>>;
  onClose: () => void;
  onMaintenance: (
    action: "archive" | "restore" | "purge",
  ) => Promise<KnowledgeResult<MaintenancePreview>>;
  blocked?: boolean;
}) {
  const { t } = useTranslation("knowledge");
  const [record, setRecord] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<
    KnowledgeErrorCode | "unexpected" | "required" | null
  >(null);
  const samePair = (pair: { source: string; target: string }) =>
    "languagePair" in record &&
    pair.source === record.languagePair.source &&
    pair.target === record.languagePair.target;
  const setPair = (source: string, target: string) => {
    if (!("languagePair" in record)) return;
    const pair = { source, target };
    if ("ruleEntryIds" in record)
      setRecord({ ...record, languagePair: pair, ruleEntryIds: [] });
    else {
      const next = { ...record, languagePair: pair, modifierStyleIds: [] };
      delete next.baseStyleId;
      setRecord(next);
    }
  };
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const existing = snapshot.data[group].some((item) => item.id === initial.id);
  const text = (
    label: FieldName,
    value: string,
    onChange: (value: string) => void,
    multiline = false,
    required = false,
  ) =>
    label === "source_language" || label === "target_language" ? (
      <LanguageField
        label={t(`fields.${label}`)}
        value={value}
        onChange={onChange}
      />
    ) : (
      <TextField
        label={t(`fields.${label}`)}
        value={value}
        onChange={onChange}
        multiline={multiline}
        required={required}
      />
    );
  const maintain = async (action: "archive" | "restore" | "purge") => {
    if (blocked || pending) return;
    setPending(true);
    setError(null);
    setDiagnostics([]);
    try {
      const result = await onMaintenance(action);
      if (!result.ok) {
        setError(result.error);
        setDiagnostics(result.diagnostics ?? []);
      }
    } catch {
      setError("unexpected");
    } finally {
      setPending(false);
    }
  };
  const submit = async () => {
    if (pending || blocked) return;
    if (
      !record.name.trim() ||
      ("ruleEntryIds" in record && !record.ruleEntryIds.length) ||
      (!("description" in record) && !record.instructions.trim())
    ) {
      setError("required");
      return;
    }
    let saving = record;
    if (
      "aboutSubjectIds" in record &&
      !record.defaultLanguagePair?.source.trim() &&
      !record.defaultLanguagePair?.target.trim()
    ) {
      const next = { ...record };
      delete next.defaultLanguagePair;
      saving = next;
    }
    if ("readCollectionIds" in record) {
      const styleIds = [record.baseStyleId, ...record.modifierStyleIds];
      const required = snapshot.data.styles
        .filter((style) => styleIds.includes(style.id))
        .flatMap((style) => style.ruleEntryIds)
        .flatMap(
          (id) =>
            snapshot.data.entries.find((entry) => entry.id === id)
              ?.collectionId ?? [],
        );
      saving = {
        ...record,
        modifierStyleIds: record.modifierStyleIds.filter(
          (id) => id !== record.baseStyleId,
        ),
        readCollectionIds: [
          ...new Set([...record.readCollectionIds, ...required]),
        ],
      };
    }
    setPending(true);
    setError(null);
    try {
      const problem = await onSave({
        generation: snapshot.generation,
        group,
        record: saving,
      });
      if (!problem.ok) {
        setError(problem.error);
        setDiagnostics(problem.diagnostics ?? []);
      } else onClose();
    } catch {
      setError("unexpected");
    } finally {
      setPending(false);
    }
  };
  return (
    <KnowledgeDialog
      title={t(existing ? "editor.edit_catalog" : "editor.new_catalog", {
        type: t(`group.${group}`),
      })}
      description={
        group === "recipes" ||
        group === "styles" ||
        group === "preferenceTemplates"
          ? t("plans.notice")
          : undefined
      }
      pending={pending}
      onClose={onClose}
      footer={
        <Button
          size="sm"
          disabled={pending || blocked}
          onClick={() => void submit()}
        >
          {t(pending ? "actions.saving" : "actions.save_catalog")}
        </Button>
      }
    >
      <fieldset disabled={pending || blocked} className="space-y-4">
        {text(
          "name",
          record.name,
          (name) => setRecord({ ...record, name }),
          false,
          true,
        )}
        {"description" in record &&
          text(
            "description",
            record.description,
            (description) => setRecord({ ...record, description }),
            true,
          )}
        {"kind" in record && (
          <>
            <Choice
              label={t("fields.subject_kind")}
              value={record.kind}
              onChange={(kind) =>
                setRecord({ ...record, kind: kind as Subject["kind"] })
              }
              options={["person", "work", "domain", "other"].map((value) => ({
                value,
                label: t(optionKey(`subject_kind.${value}`)),
              }))}
            />
            <LinesField
              label={t("fields.aliases_lines")}
              value={record.aliases.join("\n")}
              onChange={(value) =>
                setRecord({ ...record, aliases: splitLines(value) })
              }
            />
            <LinesField
              label={t("fields.tags_lines")}
              value={record.tags.join("\n")}
              onChange={(value) =>
                setRecord({ ...record, tags: splitLines(value) })
              }
            />
          </>
        )}
        {"aboutSubjectIds" in record && (
          <>
            <MultiChoice
              label={t("fields.about_subjects")}
              options={snapshot.data.subjects}
              value={record.aboutSubjectIds}
              onChange={(aboutSubjectIds) =>
                setRecord({ ...record, aboutSubjectIds })
              }
            />
            <div className="grid grid-cols-2 gap-4">
              {text(
                "source_language",
                record.defaultLanguagePair?.source ?? "",
                (source) =>
                  setRecord({
                    ...record,
                    defaultLanguagePair: {
                      source,
                      target: record.defaultLanguagePair?.target ?? "zh-Hans",
                    },
                  }),
              )}
              {text(
                "target_language",
                record.defaultLanguagePair?.target ?? "",
                (target) =>
                  setRecord({
                    ...record,
                    defaultLanguagePair: {
                      source: record.defaultLanguagePair?.source ?? "ja",
                      target,
                    },
                  }),
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("editor.language_defaults")}
            </p>
          </>
        )}
        {"languagePair" in record && (
          <p className="text-xs text-muted-foreground">
            {t("editor.language_change")}
          </p>
        )}
        {"languagePair" in record && (
          <div className="grid grid-cols-2 gap-4">
            {text(
              "source_language",
              record.languagePair.source,
              (source) => setPair(source, record.languagePair.target),
              false,
              true,
            )}
            {text(
              "target_language",
              record.languagePair.target,
              (target) => setPair(record.languagePair.source, target),
              false,
              true,
            )}
          </div>
        )}
        {"ruleEntryIds" in record && (
          <>
            <MultiChoice
              label={t("fields.rules")}
              options={snapshot.data.entries
                .filter(
                  (item) =>
                    item.kind === "rule" && samePair(item.scope.languagePair),
                )
                .map((item) => ({ id: item.id, name: item.title }))}
              value={record.ruleEntryIds}
              onChange={(ruleEntryIds) =>
                setRecord({ ...record, ruleEntryIds })
              }
            />
            <p className="text-xs text-muted-foreground">
              {t("editor.style_help")}
            </p>
          </>
        )}
        {"readCollectionIds" in record && (
          <>
            <MultiChoice
              label={t("fields.collections")}
              options={snapshot.data.collections}
              value={record.readCollectionIds}
              onChange={(readCollectionIds) =>
                setRecord({ ...record, readCollectionIds })
              }
            />
            <Choice
              label={t("fields.base_style")}
              value={record.baseStyleId ?? "none"}
              onChange={(value) => {
                const next = { ...record };
                if (value === "none") delete next.baseStyleId;
                else next.baseStyleId = value;
                setRecord(next);
              }}
              options={[
                { value: "none", label: t("filters.none") },
                ...snapshot.data.styles
                  .filter(
                    (item) => samePair(item.languagePair) && !item.archived,
                  )
                  .map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
            <MultiChoice
              label={t("fields.modifier_styles")}
              options={snapshot.data.styles.filter(
                (item) =>
                  samePair(item.languagePair) &&
                  !item.archived &&
                  item.id !== record.baseStyleId,
              )}
              value={record.modifierStyleIds}
              onChange={(modifierStyleIds) =>
                setRecord({ ...record, modifierStyleIds })
              }
            />
            <p className="text-xs text-muted-foreground">
              {t("editor.dependencies")}
            </p>
            {text(
              "instructions",
              record.instructions,
              (instructions) => setRecord({ ...record, instructions }),
              true,
            )}
            {text(
              "content_context",
              record.context,
              (context) => setRecord({ ...record, context }),
              true,
            )}
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm">
                {t("fields.subject_suggestions")}
              </summary>
              <div className="mt-4 space-y-3">
                {snapshot.data.subjects.map((subject) => {
                  const suggestion = record.subjectSuggestions.find(
                    (item) => item.subjectId === subject.id,
                  );
                  return (
                    <div
                      key={subject.id}
                      className="grid grid-cols-2 items-end gap-3"
                    >
                      <Check
                        label={subject.name}
                        checked={!!suggestion}
                        onChange={(checked) =>
                          setRecord({
                            ...record,
                            subjectSuggestions: checked
                              ? [
                                  ...record.subjectSuggestions,
                                  { subjectId: subject.id, role: "topic" },
                                ]
                              : record.subjectSuggestions.filter(
                                  (item) => item.subjectId !== subject.id,
                                ),
                          })
                        }
                      />
                      {suggestion && (
                        <Choice
                          label={t("fields.subject_role")}
                          value={suggestion.role}
                          options={(subject.kind === "person"
                            ? ["topic", "speaker", "mentioned"]
                            : ["topic", "mentioned"]
                          ).map((value) => ({
                            value,
                            label: t(optionKey(`role.${value}`)),
                          }))}
                          onChange={(role) =>
                            setRecord({
                              ...record,
                              subjectSuggestions: record.subjectSuggestions.map(
                                (item) =>
                                  item.subjectId === subject.id
                                    ? {
                                        ...item,
                                        role: role as typeof item.role,
                                      }
                                    : item,
                              ),
                            })
                          }
                        />
                      )}
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  {t("editor.suggestion_help")}
                </p>
              </div>
            </details>
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm">{t("guide.future_preferences")}</summary>
              <div className="mt-3 space-y-4">
                <p className="text-xs leading-5 text-muted-foreground">{t("guide.future_preferences_help")}</p>
                <Check
                  label={t("fields.inherit_preferences")}
                  checked={record.inheritGlobalPreferences}
                  onChange={(inheritGlobalPreferences) =>
                    setRecord({ ...record, inheritGlobalPreferences })
                  }
                />
                <Choice
                  label={t("fields.learning")}
                  value={record.learningSuggestion}
                  onChange={(value) => {
                    const next = {
                      ...record,
                      learningSuggestion: value as Recipe["learningSuggestion"],
                    };
                    if (value === "off")
                      delete next.suggestedDestinationCollectionId;
                    setRecord(next);
                  }}
                  options={["off", "save_reviewed"].map((value) => ({
                    value,
                    label: t(optionKey(`learning.${value}`)),
                  }))}
                />
                {record.learningSuggestion === "save_reviewed" && (
                  <Choice
                    label={t("fields.destination")}
                    value={record.suggestedDestinationCollectionId ?? "none"}
                    onChange={(value) =>
                      setRecord({
                        ...record,
                        suggestedDestinationCollectionId: value,
                      })
                    }
                    options={[
                      { value: "none", label: t("filters.select"), disabled: true },
                      ...snapshot.data.collections.map((item) => ({
                        value: item.id,
                        label: item.name,
                      })),
                    ]}
                  />
                )}
              </div>
            </details>
          </>
        )}
        {"instructions" in record &&
          !("readCollectionIds" in record) &&
          text(
            "instructions",
            record.instructions,
            (instructions) => setRecord({ ...record, instructions }),
            true,
            true,
          )}
        {existing && (
          <section className="space-y-3 border-t pt-4">
            <p className="text-xs text-muted-foreground">
              {t("maintenance.saved_version")}
            </p>
            <Button
              data-testid="knowledge-catalog-maintenance"
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                void maintain(initial.archived ? "restore" : "archive")
              }
            >
              {t(
                initial.archived
                  ? "maintenance.preview_restore"
                  : "maintenance.preview_archive",
              )}
            </Button>
            {initial.archived && (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {t("maintenance.advanced")}
                </summary>
                <Button
                  data-testid="knowledge-catalog-purge"
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => void maintain("purge")}
                >
                  {t("maintenance.preview_purge")}
                </Button>
              </details>
            )}
          </section>
        )}
      </fieldset>
      <ErrorNotice error={error} diagnostics={diagnostics} />
    </KnowledgeDialog>
  );
}
