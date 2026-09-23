import type { MaintenancePreview } from "@/translation-knowledge/maintenance-contract";
import { optionKey, type FieldName } from "./labels";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Archive, ArchiveRestore, FolderPen, Trash2 } from "lucide-react";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { KnowledgeFormSection, KnowledgeRecordDialog, KnowledgeRecordMenu } from "./KnowledgeRecordDialog";
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
  MultiChoice,
  TextField,
} from "./Controls";
import type { Diagnostic } from "@/translation-knowledge/validation";
import { freshId, splitLines } from "./model";
import { KnowledgeDisclosure } from "./KnowledgeDisclosure";
import { DialogTransition } from "@/components/qiuye-ui/dialog-motion";
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
  const samePair = (pair: { source: string; target: string; }) =>
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
    <KnowledgeRecordDialog
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
      error={error}
      notice={<ErrorNotice error={error} diagnostics={diagnostics} stageClassName="pt-4" />}
      onClose={onClose}
      icon={<FolderPen />}
      testId="knowledge-catalog-editor"
      wide={group === "recipes" || group === "styles"}
      closeLabel={t("record.cancel")}
      footerStart={existing && (
        <KnowledgeRecordMenu disabled={pending || blocked} testId="knowledge-catalog-more">
          <DropdownMenuLabel className="max-w-72 whitespace-normal">
            <span className="block">{t("record.saved_actions")}</span>
            <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">{t("maintenance.saved_version")}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="knowledge-catalog-maintenance"
            disabled={pending || blocked}
            onSelect={() => void maintain(initial.archived ? "restore" : "archive")}
          >
            {initial.archived ? <ArchiveRestore /> : <Archive />}
            {t(group === "collections" ? initial.archived ? "collection_actions.restore" : "collection_actions.archive" : initial.archived ? "maintenance.preview_restore" : "maintenance.preview_archive")}
          </DropdownMenuItem>
          {(group === "collections" || initial.archived) && <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="knowledge-catalog-purge"
              variant="destructive"
              disabled={pending || blocked}
              onSelect={() => void maintain("purge")}
            >
              <Trash2 />{t(group === "collections" ? "collection_actions.delete" : "maintenance.preview_purge")}
            </DropdownMenuItem>
          </>}
        </KnowledgeRecordMenu>
      )}
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
      <fieldset disabled={pending || blocked} className="knowledge-record-form">
        <KnowledgeFormSection title={t("record.basics")}>
          <div className={"kind" in record ? "knowledge-form-grid" : undefined}>
            {text("name", record.name, (name) => setRecord({ ...record, name }), false, true)}
            {"kind" in record && <Choice
              label={t("fields.subject_kind")}
              value={record.kind}
              onChange={(kind) => setRecord({ ...record, kind: kind as Subject["kind"] })}
              options={["person", "work", "domain", "other"].map((value) => ({
                value, label: t(optionKey(`subject_kind.${value}`)),
              }))}
            />}
          </div>
          {"description" in record && text("description", record.description,
            (description) => setRecord({ ...record, description }), true)}
        </KnowledgeFormSection>
        {"aboutSubjectIds" in record && (
          <KnowledgeFormSection title={t("fields.language")} description={t("editor.language_defaults")}>
            <div className="knowledge-form-grid">
              {text("source_language", record.defaultLanguagePair?.source ?? "", (source) =>
                setRecord({ ...record, defaultLanguagePair: { source, target: record.defaultLanguagePair?.target ?? "zh-Hans" } }))}
              {text("target_language", record.defaultLanguagePair?.target ?? "", (target) =>
                setRecord({ ...record, defaultLanguagePair: { source: record.defaultLanguagePair?.source ?? "ja", target } }))}
            </div>
          </KnowledgeFormSection>
        )}
        {"languagePair" in record && (
          <KnowledgeFormSection title={t("fields.language")} description={t("editor.language_change")}>
            <div className="knowledge-form-grid">
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
          </KnowledgeFormSection>
        )}
        {"ruleEntryIds" in record && (
          <KnowledgeFormSection title={t("record.references")} description={t("editor.style_help")}>
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
          </KnowledgeFormSection>
        )}
        {"readCollectionIds" in record && (
          <>
            <KnowledgeFormSection title={t("record.references")}>
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
              <p className="knowledge-editor-help">
                {t("editor.dependencies")}
              </p>
            </KnowledgeFormSection>
            <KnowledgeFormSection title={t("record.translation")}>
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
            </KnowledgeFormSection>
            <KnowledgeFormSection title={t("record.optional")}>
              <div className="knowledge-editor-disclosures">
                <KnowledgeDisclosure variant="inline" title={t("fields.subject_suggestions")}>
                  <div className="space-y-4">
                    {snapshot.data.subjects.map((subject) => {
                      const suggestion = record.subjectSuggestions.find(
                        (item) => item.subjectId === subject.id,
                      );
                      return (
                        <div
                          key={subject.id}
                          className="grid min-w-0 grid-cols-2 items-start gap-x-4 max-[560px]:grid-cols-1"
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
                          <DialogTransition transitionKey={suggestion ? 'role' : 'none'} stageClassName="max-[560px]:pt-3">{suggestion && (
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
                          )}</DialogTransition>
                        </div>
                      );
                    })}
                    <p className="knowledge-editor-help">
                      {t("editor.suggestion_help")}
                    </p>
                  </div>
                </KnowledgeDisclosure>
                <KnowledgeDisclosure variant="inline" title={t("guide.future_preferences")}>
                  <div className="space-y-4">
                    <p className="knowledge-editor-help">{t("guide.future_preferences_help")}</p>
                    <Check
                      label={t("fields.inherit_preferences")}
                      checked={record.inheritGlobalPreferences}
                      onChange={(inheritGlobalPreferences) =>
                        setRecord({ ...record, inheritGlobalPreferences })
                      }
                    />
                    <div>
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
                    <DialogTransition transitionKey={record.learningSuggestion} stageClassName="pt-4">{record.learningSuggestion === "save_reviewed" && (
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
                    )}</DialogTransition>
                    </div>
                  </div>
                </KnowledgeDisclosure>
              </div>
            </KnowledgeFormSection>
          </>
        )}
        {"instructions" in record && !("readCollectionIds" in record) && (
          <KnowledgeFormSection title={t("record.translation")}>
            {text(
              "instructions",
              record.instructions,
              (instructions) => setRecord({ ...record, instructions }),
              true,
              true,
            )}
          </KnowledgeFormSection>
        )}
        {("kind" in record || "aboutSubjectIds" in record) && (
          <div className="knowledge-editor-disclosures">
            <KnowledgeDisclosure variant="inline" title={t("workspace.collection_optional")}>
              <div className="space-y-4">
                {"kind" in record && <div className="knowledge-form-grid">
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

                </div>}
                {"aboutSubjectIds" in record && <MultiChoice
                  label={t("fields.about_subjects")}
                  options={snapshot.data.subjects}
                  value={record.aboutSubjectIds}
                  onChange={(aboutSubjectIds) => setRecord({ ...record, aboutSubjectIds })}
                />}
              </div>
            </KnowledgeDisclosure>
          </div>
        )}
      </fieldset>
    </KnowledgeRecordDialog>
  );
}
