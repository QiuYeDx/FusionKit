import { optionKey, type FieldName } from "./labels";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FilePenLine, Info, Layers3, ShieldCheck, SlidersHorizontal } from "lucide-react";
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
  TextField,
} from "./Controls";
import type { Diagnostic } from "@/translation-knowledge/validation";
import { manualEntryRequest, splitLines } from "./model";
import { ClipPathTabs } from "@/components/qiuye-ui/clip-path-tabs";
import { EntrySettingsPanel } from "./EntrySettingsPanel";
import { DialogMotionRegion, DialogTransition } from "@/components/qiuye-ui/dialog-motion";
import { ToolSwitchRow, ToolToggleRow } from "@/pages/Tools/_shared/ui/ToolSwitchRow";

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
  const [settingsTab, setSettingsTab] = useState(initial.kind === "term" || initial.kind === "rule" ? "wording" : "language");
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
      setSettingsTab("scope");
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
      if (!pair.source.trim() || !pair.target.trim()) setSettingsTab("language");
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
      notice={<ErrorNotice error={error} diagnostics={diagnostics} stageClassName="pt-4" />}
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
      <fieldset disabled={pending || blocked} className="knowledge-record-form knowledge-entry-editor-form">
        <KnowledgeFormSection title={t("record.basics")}>
          <div className="knowledge-form-grid">
            <Choice
              label={t("fields.kind")}
              value={entry.kind}
              onChange={(value) => {
                setEntry(changeKind(entry, value as Entry["kind"]));
                setSettingsTab(value === "term" || value === "rule" ? "wording" : "language");
              }}
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
          <DialogTransition transitionKey={entry.kind} className="min-w-0">
          <div className="flex min-w-0 flex-col gap-3">
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
          </div>
          </DialogTransition>
        </KnowledgeFormSection>
        <KnowledgeFormSection title={t("record.settings")} className="knowledge-entry-settings-section">
          <ClipPathTabs value={settingsTab} onValueChange={setSettingsTab} size="sm" shape="rounded" smoothCorners fullWidth
            disabled={pending || blocked} ariaLabel={t("record.settings")} className="knowledge-entry-settings-tabs"
            items={[
              ...(entry.kind === "term" || entry.kind === "rule" ? [{ value: "wording", label: t("record.tab_wording") }] : []),
              { value: "language", label: t("record.tab_language") },
              { value: "scope", label: t("record.tab_scope") },
              { value: "metadata", label: t("record.tab_metadata") },
            ]}>
            <DialogMotionRegion><div className="knowledge-entry-settings-panels">
            {entry.kind === "term" && (
              <EntrySettingsPanel value="wording" active={settingsTab === "wording"}>
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
                  <ToolSwitchRow
                    disabled={pending || blocked}
                    label={t("fields.case_sensitive")}
                    checked={entry.payload.match.caseSensitive}
                    onCheckedChange={(caseSensitive) =>
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
              </EntrySettingsPanel>
            )}
            {entry.kind === "rule" && (
              <EntrySettingsPanel value="wording" active={settingsTab === "wording"}>
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
              </EntrySettingsPanel>
            )}
            <EntrySettingsPanel value="language" active={settingsTab === "language"}>
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
            </EntrySettingsPanel>
            <EntrySettingsPanel value="scope" active={settingsTab === "scope"}>
              <div className="knowledge-scope-builder">
                <div className="knowledge-scope-intro">
                  <div className="knowledge-scope-intro-icon" aria-hidden="true"><ShieldCheck /></div>
                  <div className="knowledge-scope-intro-copy">
                    <div className="knowledge-scope-intro-title">{t("editor.scope")}</div>
                    <p>{t("editor.scope_help")}</p>
                  </div>
                  <div className="knowledge-scope-summary" aria-label={t("editor.scope")}>
                    <span className="knowledge-scope-summary-item"><strong>{entry.scope.requiredSubjects.length}</strong>{t("fields.subject_role")}</span>
                    <span className="knowledge-scope-summary-item"><strong>{entry.aboutSubjectIds.length}</strong>{t("fields.about_subjects")}</span>
                  </div>
                </div>

                <section className="knowledge-scope-card" aria-labelledby="knowledge-scope-about-subjects">
                  <div className="knowledge-scope-card-heading">
                    <div className="knowledge-scope-card-icon" aria-hidden="true"><Layers3 /></div>
                    <div>
                      <h4 id="knowledge-scope-about-subjects">{t("fields.about_subjects")}</h4>
                    </div>
                    <span className="knowledge-scope-count">{entry.aboutSubjectIds.length}</span>
                  </div>
                  <div className="knowledge-scope-subject-list">
                    {snapshot.data.subjects.length ? snapshot.data.subjects.map((subject) => {
                      const selected = entry.aboutSubjectIds.includes(subject.id);
                      return <ToolToggleRow key={subject.id}
                          control="checkbox"
                          disabled={pending || blocked}
                          label={subject.name}
                          hint={t(`subject_kind.${subject.kind}`)}
                          checked={selected}
                          onCheckedChange={(checked) => setEntry({ ...entry, aboutSubjectIds: checked ? [...entry.aboutSubjectIds, subject.id] : entry.aboutSubjectIds.filter((id) => id !== subject.id) })}
                        />;
                    }) : <p className="knowledge-scope-empty">{t("empty.options")}</p>}
                  </div>
                </section>

                <section className="knowledge-scope-card knowledge-scope-requirements" aria-labelledby="knowledge-scope-requirements-title">
                  <div className="knowledge-scope-card-heading">
                    <div className="knowledge-scope-card-icon" aria-hidden="true"><SlidersHorizontal /></div>
                    <div>
                      <h4 id="knowledge-scope-requirements-title">{t("fields.subject_role")}</h4>
                    </div>
                    <span className="knowledge-scope-count">{entry.scope.requiredSubjects.length}</span>
                  </div>
                  <div className="knowledge-scope-requirement-list">
                    {snapshot.data.subjects.length ? snapshot.data.subjects.map((subject) => {
                      const condition = entry.scope.requiredSubjects.find((item) => item.subjectId === subject.id);
                      return <ToolToggleRow key={subject.id}
                        control="checkbox"
                        detailsClassName="p-0"
                        disabled={pending || blocked}
                        label={subject.name}
                        hint={t(`subject_kind.${subject.kind}`)}
                        checked={!!condition}
                        onCheckedChange={(checked) => setEntry({ ...entry, scope: { ...entry.scope, requiredSubjects: checked ? [...entry.scope.requiredSubjects, { subjectId: subject.id, role: "topic" }] : entry.scope.requiredSubjects.filter((item) => item.subjectId !== subject.id) } })}
                      >
                        <DialogTransition transitionKey={condition ? 'required' : 'optional'}>{condition && <div className="knowledge-scope-role-field px-3 pb-3">
                          <Choice
                            label={t("fields.subject_role")}
                            value={condition.role}
                            options={options("role", subject.kind === "person" ? ["topic", "speaker", "mentioned", "present"] : ["topic", "mentioned", "present"])}
                            onChange={(role) => setEntry({ ...entry, scope: { ...entry.scope, requiredSubjects: entry.scope.requiredSubjects.map((item) => item.subjectId === subject.id ? { ...item, role: role as typeof item.role } : item) } })}
                          />
                        </div>}</DialogTransition>
                      </ToolToggleRow>;
                    }) : <p className="knowledge-scope-empty">{t("empty.options")}</p>}
                  </div>
                </section>

                <section className="knowledge-scope-card knowledge-scope-condition" aria-labelledby="knowledge-scope-condition-title">
                  <div className="knowledge-scope-card-heading">
                    <div className="knowledge-scope-card-icon" aria-hidden="true"><Info /></div>
                    <div>
                      <h4 id="knowledge-scope-condition-title">{t("fields.condition")}</h4>
                    </div>
                  </div>
                  <div>
                  <Choice
                    label={t("fields.condition")}
                    value={entry.scope.condition.mode}
                    options={options("condition", (entry.kind === "term" || entry.kind === "rule") && entry.payload.strength === "required" ? ["none", "requires_confirmation"] : ["none", "advisory", "requires_confirmation"])}
                    onChange={(mode) => setEntry({ ...entry, scope: { ...entry.scope, condition: mode === "none" ? { mode: "none" } : { mode: mode as "advisory" | "requires_confirmation", text: "" } } })}
                  />
                  <DialogTransition transitionKey={entry.scope.condition.mode === 'none' ? 'none' : 'condition'} stageClassName="pt-3">{entry.scope.condition.mode !== "none" && text("condition_text", entry.scope.condition.text, (value) => setEntry({ ...entry, scope: { ...entry.scope, condition: { ...entry.scope.condition, mode: entry.scope.condition.mode as "advisory" | "requires_confirmation", text: value } } }), true, true)}</DialogTransition>
                  </div>
                </section>
              </div>
            </EntrySettingsPanel>
            <EntrySettingsPanel value="metadata" active={settingsTab === "metadata"}>
              <div className="space-y-4">
                {text("title_optional", entry.title, (title) =>
                  setEntry({ ...entry, title }),
                )}
                {text("source_note", sourceNote, setSourceNote, true)}
                <p className="knowledge-editor-help">
                  {t(existing ? "editor.source_existing" : "editor.source_default")}
                </p>
              </div>
            </EntrySettingsPanel>
            </div></DialogMotionRegion>
          </ClipPathTabs>
        </KnowledgeFormSection>
      </fieldset>
    </KnowledgeRecordDialog>
  );
}
