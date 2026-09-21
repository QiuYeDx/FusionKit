import { languagePairLabel, optionKey, scopeSummary, type FieldName } from "./labels";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FilePenLine } from "lucide-react";
import { KnowledgeFormSection, KnowledgeRecordDialog } from "./KnowledgeRecordDialog";
import type { Entry } from "@/translation-knowledge/schemas";
import type {
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
import { manualEntryRequest, splitLines } from "./model";
import { KnowledgeDisclosure } from "./KnowledgeDisclosure";

function changeKind(entry: Entry, kind: Entry["kind"]): Entry {
  const base = { ...entry, kind };
  switch (kind) {
    case "term":
      return {
        ...base,
        kind,
        payload: {
          source: "",
          target: "",
          aliases: [],
          sense: "",
          match: { mode: "literal_phrase", caseSensitive: true },
          strength: "preferred",
        },
      };
    case "context":
      return {
        ...base,
        kind,
        payload: { text: "", assertion: "fact", core: false },
      };
    case "expression":
      return {
        ...base,
        kind,
        payload: {
          sourcePhrase: "",
          interpretation: "",
          targetExamples: [],
          mustNotInventOccurrences: true,
        },
      };
    case "memory":
      return {
        ...base,
        kind,
        payload: {
          source: "",
          target: "",
          alignment: "one_to_one",
          directReuseAllowed: false,
        },
      };
    case "rule":
      return {
        ...base,
        kind,
        payload: { dimension: "other", text: "", strength: "preferred" },
      };
  }
}
export function EntryEditor({
  initial,
  snapshot,
  onSave,
  onClose,
  blocked = false,
}: {
  initial: Entry;
  snapshot: LibrarySnapshot;
  onSave: (
    request: SaveRecordRequest,
  ) => Promise<KnowledgeResult<LibrarySnapshot>>;
  onClose: () => void;
  blocked?: boolean;
}) {
  const { t } = useTranslation("knowledge");
  const [entry, setEntry] = useState(initial);
  const [sourceNote, setSourceNote] = useState("");
  const [pending, setPending] = useState(false);
  const submitLock = useRef(false);
  const [error, setError] = useState<
    KnowledgeErrorCode | "unexpected" | "required" | null
  >(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const existing = snapshot.data.entries.some((item) => item.id === initial.id);
  const options = (group: string, values: string[]) =>
    values.map((value) => ({
      value,
      label: t(optionKey(`${group}.${value}`)),
    }));
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
  const pair = entry.scope.languagePair;
  const submit = async (adopt: boolean) => {
    if (submitLock.current || pending || blocked) return;
    if (
      entry.scope.condition.mode !== "none" &&
      !entry.scope.condition.text.trim()
    ) {
      setError("required");
      return;
    }
    const required =
      entry.kind === "term" || entry.kind === "memory"
        ? [entry.payload.source, entry.payload.target]
        : entry.kind === "expression"
          ? [entry.payload.sourcePhrase, entry.payload.interpretation]
          : [entry.payload.text];
    if (
      required.some((value) => !value.trim()) ||
      !pair.source.trim() ||
      !pair.target.trim()
    ) {
      setError("required");
      return;
    }
    submitLock.current = true;
    setPending(true);
    setError(null);
    try {
      const problem = await onSave(manualEntryRequest(entry, snapshot, adopt, t("source.manual"), sourceNote));
      if (!problem.ok) {
        setError(problem.error);
        setDiagnostics(problem.diagnostics ?? []);
      } else onClose();
    } catch {
      setError("unexpected");
    } finally {
      submitLock.current = false;
      setPending(false);
    }
  };
  return (
    <KnowledgeRecordDialog
      title={t(existing ? "editor.edit_entry" : "editor.new_entry")}
      description={t("editor.entry_help")}
      icon={<FilePenLine />}
      testId="knowledge-entry-editor"
      closeLabel={t("record.cancel")}
      onClose={onClose}
      pending={pending}
      error={error}
      footerStart={initial.state !== "archived" && (
        <Button data-testid="knowledge-save-draft" variant="outline" size="sm" disabled={pending || blocked} onClick={() => void submit(false)}>{t("workspace.save_draft")}</Button>
      )}
      footer={
        <>
          <Button data-testid="knowledge-save-apply" size="sm" disabled={pending || blocked} onClick={() => void submit(initial.state !== "archived")}>
            {t(pending ? "actions.saving" : initial.state === "archived" ? "actions.save_catalog" : "workspace.save_apply")}
          </Button>
        </>
      }
    >
      <fieldset disabled={pending || blocked} className="knowledge-record-form">
        <KnowledgeFormSection title={t("record.basics")}>
          <div className="knowledge-form-grid">
            <Choice
              label={t("fields.kind")}
              value={entry.kind}
              onChange={(value) =>
                setEntry(changeKind(entry, value as Entry["kind"]))
              }
              options={options("kind", existing ? [initial.kind] : ["term", "context", "rule"])}
              disabled={existing}
            />
            <Choice
              label={t("fields.collection")}
              value={entry.collectionId}
              onChange={(value) => setEntry({ ...entry, collectionId: value })}
              options={snapshot.data.collections.map((item) => ({
                value: item.id,
                label: item.name,
              }))}
            />
          </div>
        </KnowledgeFormSection>
        <KnowledgeFormSection title={t("record.content")}>
          {(entry.kind === "expression" || entry.kind === "memory") && <p className="knowledge-editor-help">{t("guide.storage_only_help")}</p>}
          {(entry.kind === "term" || entry.kind === "memory") && (
            <div className="knowledge-form-grid">
              {text(
                "source_text",
                entry.payload.source,
                (source) =>
                  setEntry(
                    entry.kind === "term"
                      ? {
                        ...entry,
                        payload: {
                          ...entry.payload,
                          source,
                          target:
                            entry.payload.strength === "keep_source"
                              ? source
                              : entry.payload.target,
                        },
                      }
                      : { ...entry, payload: { ...entry.payload, source } },
                  ),
                entry.kind === "memory",
                true,
              )}
              {text(
                "target_text",
                entry.payload.target,
                (target) =>
                  setEntry(
                    entry.kind === "term"
                      ? { ...entry, payload: { ...entry.payload, target } }
                      : { ...entry, payload: { ...entry.payload, target } },
                  ),
                entry.kind === "memory",
                true,
              )}
            </div>
          )}
          {entry.kind === "context" && (
            <>
              {text(
                "context_text",
                entry.payload.text,
                (text) =>
                  setEntry({ ...entry, payload: { ...entry.payload, text } }),
                true,
                true,
              )}
              <Choice
                label={t("fields.assertion")}
                value={entry.payload.assertion}
                onChange={(assertion) =>
                  setEntry({
                    ...entry,
                    payload: {
                      ...entry.payload,
                      assertion: assertion as typeof entry.payload.assertion,
                      core:
                        assertion === "uncertain" ? false : entry.payload.core,
                    },
                  })
                }
                options={options("assertion", ["fact", "reported", "uncertain"])}
              />
              <Check
                label={t("fields.core")}
                checked={entry.payload.core}
                disabled={entry.payload.assertion === "uncertain"}
                onChange={(core) =>
                  setEntry({ ...entry, payload: { ...entry.payload, core } })
                }
              />
            </>
          )}
          {entry.kind === "expression" && (
            <>
              {text(
                "source_phrase",
                entry.payload.sourcePhrase,
                (sourcePhrase) =>
                  setEntry({
                    ...entry,
                    payload: { ...entry.payload, sourcePhrase },
                  }),
                false,
                true,
              )}
              {text(
                "interpretation",
                entry.payload.interpretation,
                (interpretation) =>
                  setEntry({
                    ...entry,
                    payload: { ...entry.payload, interpretation },
                  }),
                true,
                true,
              )}
              <LinesField
                label={t("fields.examples_lines")}
                value={entry.payload.targetExamples.join("\n")}
                onChange={(value) =>
                  setEntry({
                    ...entry,
                    payload: {
                      ...entry.payload,
                      targetExamples: splitLines(value),
                    },
                  })
                }
              />
              <p className="knowledge-editor-help">
                {t("editor.expression_help")} {t("editor.expression_scope")}
              </p>
            </>
          )}
          {entry.kind === "memory" && (
            <>
              <div className="knowledge-form-grid">
                {text(
                  "before_source",
                  entry.payload.beforeSource ?? "",
                  (beforeSource) =>
                    setEntry({
                      ...entry,
                      payload: { ...entry.payload, beforeSource },
                    }),
                  true,
                )}
                {text(
                  "after_source",
                  entry.payload.afterSource ?? "",
                  (afterSource) =>
                    setEntry({
                      ...entry,
                      payload: { ...entry.payload, afterSource },
                    }),
                  true,
                )}
              </div>
              <Choice
                label={t("fields.alignment")}
                value={entry.payload.alignment}
                onChange={(alignment) =>
                  setEntry({
                    ...entry,
                    payload: {
                      ...entry.payload,
                      alignment: alignment as typeof entry.payload.alignment,
                    },
                  })
                }
                options={options("alignment", ["one_to_one", "reviewed_segment"])}
              />
              <p className="knowledge-editor-help">
                {t("editor.memory_help")}
              </p>
            </>
          )}
          {entry.kind === "rule" && (
            <>
              {text(
                "rule_text",
                entry.payload.text,
                (text) =>
                  setEntry({ ...entry, payload: { ...entry.payload, text } }),
                true,
                true,
              )}

            </>
          )}
        </KnowledgeFormSection>
        <KnowledgeFormSection title={t("record.settings")}>
          <div className="knowledge-editor-disclosures">
            {entry.kind === "term" && (
              <KnowledgeDisclosure
                variant="inline"
                title={t("guide.term_options")}
                description={t(`strength.${entry.payload.strength}`)}
              >
                <div className="space-y-4">
                  {text("sense", entry.payload.sense, (sense) =>
                    setEntry({ ...entry, payload: { ...entry.payload, sense } }),
                  )}
                  <div className="knowledge-form-grid">
                    <Choice
                      label={t("fields.strength")}
                      value={entry.payload.strength}
                      onChange={(strength) =>
                        setEntry({
                          ...entry,
                          payload: {
                            ...entry.payload,
                            strength: strength as typeof entry.payload.strength,
                            target:
                              strength === "keep_source"
                                ? entry.payload.source
                                : entry.payload.target,
                          },
                        })
                      }
                      options={options("strength", [
                        "preferred",
                        "required",
                        "keep_source",
                      ])}
                    />
                    <Choice
                      label={t("fields.match")}
                      value={entry.payload.match.mode}
                      onChange={(mode) =>
                        setEntry({
                          ...entry,
                          payload: {
                            ...entry.payload,
                            match: {
                              ...entry.payload.match,
                              mode: mode as "whole_term" | "literal_phrase",
                            },
                          },
                        })
                      }
                      options={options("match", ["literal_phrase", "whole_term"])}
                    />
                  </div>
                  <Check
                    label={t("fields.case_sensitive")}
                    checked={entry.payload.match.caseSensitive}
                    onChange={(caseSensitive) =>
                      setEntry({
                        ...entry,
                        payload: {
                          ...entry.payload,
                          match: { ...entry.payload.match, caseSensitive },
                        },
                      })
                    }
                  />
                  <LinesField
                    label={t("fields.aliases_lines")}
                    value={entry.payload.aliases.join("\n")}
                    onChange={(value) =>
                      setEntry({
                        ...entry,
                        payload: { ...entry.payload, aliases: splitLines(value) },
                      })
                    }
                  />
                </div>
              </KnowledgeDisclosure>
            )}
            {entry.kind === "rule" && (
              <KnowledgeDisclosure variant="inline" title={t("workspace.more_options")}>
                <div className="knowledge-form-grid">
                  <Choice
                    label={t("fields.dimension")}
                    value={entry.payload.dimension}
                    onChange={(dimension) =>
                      setEntry({
                        ...entry,
                        payload: {
                          ...entry.payload,
                          dimension: dimension as typeof entry.payload.dimension,
                        },
                      })
                    }
                    options={options("dimension", [
                      "register",
                      "honorifics",
                      "person_reference",
                      "fidelity",
                      "other",
                    ])}
                  />
                  <Choice
                    label={t("fields.strength")}
                    value={entry.payload.strength}
                    onChange={(strength) =>
                      setEntry({
                        ...entry,
                        payload: {
                          ...entry.payload,
                          strength: strength as typeof entry.payload.strength,
                        },
                      })
                    }
                    options={options("strength", ["preferred", "required"])}
                  />
                </div>
              </KnowledgeDisclosure>
            )}
            <KnowledgeDisclosure
              variant="inline"
              data-testid="knowledge-entry-language"
              title={t("fields.language")}
              description={languagePairLabel(t, pair)}
            >
              <div className="knowledge-form-grid">
                {text(
                  "source_language",
                  pair.source,
                  (source) =>
                    setEntry({
                      ...entry,
                      scope: { ...entry.scope, languagePair: { ...pair, source } },
                    }),
                  false,
                  true,
                )}
                {text(
                  "target_language",
                  pair.target,
                  (target) =>
                    setEntry({
                      ...entry,
                      scope: { ...entry.scope, languagePair: { ...pair, target } },
                    }),
                  false,
                  true,
                )}
              </div>
            </KnowledgeDisclosure>
            <KnowledgeDisclosure
              variant="inline"
              title={t("editor.scope")}
              description={scopeSummary(t, entry.scope, snapshot.data.subjects)}
            >
              <div className="space-y-4">
                <p className="knowledge-editor-help">
                  {t("editor.scope_help")}
                </p>
                <MultiChoice
                  label={t("fields.about_subjects")}
                  options={snapshot.data.subjects}
                  value={entry.aboutSubjectIds}
                  onChange={(aboutSubjectIds) =>
                    setEntry({ ...entry, aboutSubjectIds })
                  }
                />
                <div className="space-y-4">
                  {snapshot.data.subjects.map((subject) => {
                    const condition = entry.scope.requiredSubjects.find(
                      (item) => item.subjectId === subject.id,
                    );
                    return (
                      <div
                        key={subject.id}
                        className="knowledge-form-grid items-end"
                      >
                        <Check
                          label={subject.name}
                          checked={!!condition}
                          onChange={(checked) =>
                            setEntry({
                              ...entry,
                              scope: {
                                ...entry.scope,
                                requiredSubjects: checked
                                  ? [
                                    ...entry.scope.requiredSubjects,
                                    { subjectId: subject.id, role: "topic" },
                                  ]
                                  : entry.scope.requiredSubjects.filter(
                                    (item) => item.subjectId !== subject.id,
                                  ),
                              },
                            })
                          }
                        />
                        {condition && (
                          <Choice
                            label={t("fields.subject_role")}
                            value={condition.role}
                            options={options(
                              "role",
                              subject.kind === "person"
                                ? ["topic", "speaker", "mentioned", "present"]
                                : ["topic", "mentioned", "present"],
                            )}
                            onChange={(role) =>
                              setEntry({
                                ...entry,
                                scope: {
                                  ...entry.scope,
                                  requiredSubjects:
                                    entry.scope.requiredSubjects.map((item) =>
                                      item.subjectId === subject.id
                                        ? {
                                          ...item,
                                          role: role as typeof item.role,
                                        }
                                        : item,
                                    ),
                                },
                              })
                            }
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
                <Choice
                  label={t("fields.condition")}
                  value={entry.scope.condition.mode}
                  options={options(
                    "condition",
                    (entry.kind === "term" || entry.kind === "rule") &&
                      entry.payload.strength === "required"
                      ? ["none", "requires_confirmation"]
                      : ["none", "advisory", "requires_confirmation"],
                  )}
                  onChange={(mode) =>
                    setEntry({
                      ...entry,
                      scope: {
                        ...entry.scope,
                        condition:
                          mode === "none"
                            ? { mode: "none" }
                            : {
                              mode: mode as "advisory" | "requires_confirmation",
                              text: "",
                            },
                      },
                    })
                  }
                />
                {entry.scope.condition.mode !== "none" &&
                  text(
                    "condition_text",
                    entry.scope.condition.text,
                    (text) =>
                      setEntry({
                        ...entry,
                        scope: {
                          ...entry.scope,
                          condition: {
                            ...entry.scope.condition,
                            mode: entry.scope.condition.mode as
                              | "advisory"
                              | "requires_confirmation",
                            text,
                          },
                        },
                      }),
                    true,
                    true,
                  )}
              </div>
            </KnowledgeDisclosure>
            <KnowledgeDisclosure title={t("guide.entry_metadata")} variant="inline">
              <div className="space-y-4">
                {text("title_optional", entry.title, (title) =>
                  setEntry({ ...entry, title }),
                )}
                {text("source_note", sourceNote, setSourceNote, true)}
                <p className="knowledge-editor-help">
                  {t(existing ? "editor.source_existing" : "editor.source_default")}
                </p>
              </div>
            </KnowledgeDisclosure>
          </div>
        </KnowledgeFormSection>
        {initial.state !== "archived" && <p className="knowledge-editor-help">{t("workspace.apply_help")}</p>}
      </fieldset>
      <ErrorNotice error={error} diagnostics={diagnostics} />
    </KnowledgeRecordDialog>
  );
}
