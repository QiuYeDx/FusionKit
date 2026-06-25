import { useTranslation } from "react-i18next";
import { Cpu, Folder, FolderOpen, Languages, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { InfoHint, ToolField, ToolSection } from "@/pages/Tools/_shared/ui";
import {
  DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT,
  TEXT_TRANSLATION_TOKEN_LIMITS,
  type TextTranslationBilingualLabelMode,
  type TextTranslationConflictPolicy,
  type TextTranslationExecutionMode,
  type TextTranslationOutputMode,
  type TextTranslationOutputPathMode,
  type TextTranslationProjectMode,
} from "@/type/textTranslation";
import type { TranslationLanguage } from "@/type/subtitle";
import { formatTokens } from "@/utils/tokenEstimate";
import type useTextTranslatorStore from "@/store/tools/text/useTextTranslatorStore";

type Preferences = ReturnType<
  typeof useTextTranslatorStore.getState
>["preferences"];

type ConfigPanelProps = {
  preferences: Preferences;
  updatePreferences: (patch: Partial<Preferences>) => void;
  disabled: boolean;
  sourceLanguages: Array<{ code: string; label: string }>;
  targetLanguages: Array<{ code: string; label: string }>;
  budgetUsagePercent: number;
  isBudgetExceeded: boolean;
  requiredContextTokens: number;
  outputTokenReserve: number;
  onSelectOutputPath: () => void;
};

export default function ConfigPanel({
  preferences,
  updatePreferences,
  disabled,
  sourceLanguages,
  targetLanguages,
  budgetUsagePercent,
  isBudgetExceeded,
  requiredContextTokens,
  outputTokenReserve,
  onSelectOutputPath,
}: ConfigPanelProps) {
  const { t } = useTranslation("text");
  const isSequential = preferences.executionMode === "sequential_context";

  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle className="text-base">
          {t("translator.config.title")}
        </CardTitle>
        <CardDescription>{t("translator.config.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-0">
        {/* ── Basic Settings ── */}
        <ToolSection
          title={t("translator.sections.basic")}
          icon={Languages}
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <ToolField label={t("translator.config.source_lang")}>
                <Select
                  value={preferences.sourceLang}
                  onValueChange={(v) =>
                    updatePreferences({
                      sourceLang: v as TranslationLanguage | "AUTO",
                    })
                  }
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceLanguages.map((l) => (
                      <SelectItem key={l.code} value={l.code}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </ToolField>
              <ToolField label={t("translator.config.target_lang")}>
                <Select
                  value={preferences.targetLang}
                  onValueChange={(v) =>
                    updatePreferences({
                      targetLang: v as TranslationLanguage,
                    })
                  }
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {targetLanguages.map((l) => (
                      <SelectItem key={l.code} value={l.code}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </ToolField>
            </div>

            <ToolField label={t("translator.config.output_content")}>
              <ButtonGroup className="w-full">
                <Button
                  size="sm"
                  className="flex-1"
                  variant={preferences.outputMode === "target_only" ? "default" : "outline"}
                  onClick={() => updatePreferences({ outputMode: "target_only" })}
                  disabled={disabled}
                >
                  {t("translator.output.target_only")}
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  variant={preferences.outputMode === "bilingual" ? "default" : "outline"}
                  onClick={() => updatePreferences({ outputMode: "bilingual" })}
                  disabled={disabled}
                >
                  {t("translator.output.bilingual")}
                </Button>
              </ButtonGroup>
            </ToolField>

            {preferences.outputMode === "bilingual" ? (
              <ToolField label={t("translator.config.bilingual_label_mode")}>
                <ButtonGroup className="w-full">
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={preferences.bilingualLabelMode === "none" ? "default" : "outline"}
                    onClick={() => updatePreferences({ bilingualLabelMode: "none" })}
                    disabled={disabled}
                  >
                    {t("translator.output.bilingual_simple")}
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={preferences.bilingualLabelMode === "labels" ? "default" : "outline"}
                    onClick={() => updatePreferences({ bilingualLabelMode: "labels" })}
                    disabled={disabled}
                  >
                    {t("translator.output.bilingual_labels")}
                  </Button>
                </ButtonGroup>
              </ToolField>
            ) : null}
          </div>
        </ToolSection>

        <Separator className="my-4" />

        {/* ── Engine ── */}
        <ToolSection
          title={t("translator.sections.engine")}
          icon={Cpu}
          hint={
            isSequential
              ? t("translator.execution.sequential_desc")
              : t("translator.execution.parallel_desc")
          }
          summary={
            isSequential
              ? t("translator.execution.sequential_context")
              : t("translator.execution.parallel")
          }
        >
          <div className="space-y-3">
            <ToolField label={t("translator.config.execution_mode")}>
              <ButtonGroup className="w-full">
                <Button
                  size="sm"
                  className="flex-1"
                  variant={preferences.executionMode === "parallel" ? "default" : "outline"}
                  onClick={() => updatePreferences({ executionMode: "parallel" })}
                  disabled={disabled}
                >
                  {t("translator.execution.parallel")}
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  variant={preferences.executionMode === "sequential_context" ? "default" : "outline"}
                  onClick={() => updatePreferences({ executionMode: "sequential_context" })}
                  disabled={disabled}
                >
                  {t("translator.execution.sequential_context")}
                </Button>
              </ButtonGroup>
            </ToolField>
            <ToolField label={t("translator.config.project_mode")}>
              <ButtonGroup className="w-full">
                <Button
                  size="sm"
                  className="flex-1"
                  variant={preferences.projectMode === "independent_files" ? "default" : "outline"}
                  onClick={() => updatePreferences({ projectMode: "independent_files" })}
                  disabled={disabled}
                >
                  {t("translator.project.independent")}
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  variant={preferences.projectMode === "ordered_project" ? "default" : "outline"}
                  onClick={() => updatePreferences({ projectMode: "ordered_project" })}
                  disabled={disabled}
                >
                  {t("translator.project.ordered")}
                </Button>
              </ButtonGroup>
            </ToolField>

            <div className="grid grid-cols-2 gap-3">
              <ToolField label={t("translator.config.slice_tokens")}>
                <Input
                  type="number"
                  min={TEXT_TRANSLATION_TOKEN_LIMITS.minSliceTokenLimit}
                  max={TEXT_TRANSLATION_TOKEN_LIMITS.maxSliceTokenLimit}
                  value={preferences.sliceTokenLimit}
                  disabled={disabled}
                  onChange={(e) =>
                    updatePreferences({
                      sliceTokenLimit: clampInt(
                        Number(e.target.value),
                        TEXT_TRANSLATION_TOKEN_LIMITS.minSliceTokenLimit,
                        TEXT_TRANSLATION_TOKEN_LIMITS.maxSliceTokenLimit,
                      ),
                    })
                  }
                />
              </ToolField>
              <ToolField label={t("translator.config.concurrency")}>
                <Select
                  value={String(preferences.parallelSliceConcurrency)}
                  onValueChange={(v) =>
                    updatePreferences({
                      parallelSliceConcurrency: Number(v),
                    })
                  }
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3].map((v) => (
                      <SelectItem key={v} value={String(v)}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </ToolField>
            </div>

            {/* Compact budget bar */}
            <div className="space-y-1.5 rounded-lg border bg-muted/20 px-3 py-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground/80">
                  {t("translator.budget.title")}
                  <InfoHint contentClassName="max-w-[280px]">
                    <div className="space-y-1.5">
                      <div className="flex justify-between gap-4">
                        <span>{t("translator.budget.model_context")}</span>
                        <span className="font-medium tabular-nums">
                          {formatTokens(
                            DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span>{t("translator.budget.required")}</span>
                        <span className="font-medium tabular-nums">
                          {formatTokens(requiredContextTokens)}
                        </span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span>{t("translator.budget.output_reserve")}</span>
                        <span className="font-medium tabular-nums">
                          {formatTokens(outputTokenReserve)}
                        </span>
                      </div>
                      <p className="pt-0.5 opacity-80">
                        {isBudgetExceeded
                          ? t("translator.budget.exceeded")
                          : t("translator.budget.within")}
                      </p>
                    </div>
                  </InfoHint>
                </span>
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    isBudgetExceeded
                      ? "font-semibold text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {budgetUsagePercent}%
                </span>
              </div>
              <Progress
                value={Math.min(budgetUsagePercent, 100)}
                className={cn(
                  "h-1.5",
                  isBudgetExceeded &&
                    "*:data-[slot=progress-indicator]:bg-destructive",
                )}
              />
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>
                  {formatTokens(requiredContextTokens)}
                </span>
                <span>
                  {formatTokens(
                    DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT,
                  )}
                </span>
              </div>
            </div>
          </div>
        </ToolSection>

        {/* ── Prompt Engineering (sequential only) ── */}
        {isSequential ? (
          <>
            <Separator className="my-4" />
            <ToolSection
              title={t("translator.sections.prompt")}
              icon={Sparkles}
              defaultOpen={false}
            >
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <ToolField label={t("translator.config.memory_tokens")}>
                    <Input
                      type="number"
                      min={
                        TEXT_TRANSLATION_TOKEN_LIMITS.minSemanticMemoryTokenLimit
                      }
                      value={preferences.semanticMemoryTokenLimit}
                      disabled={disabled}
                      onChange={(e) =>
                        updatePreferences({
                          semanticMemoryTokenLimit: clampInt(
                            Number(e.target.value),
                            TEXT_TRANSLATION_TOKEN_LIMITS.minSemanticMemoryTokenLimit,
                            DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT,
                          ),
                        })
                      }
                    />
                  </ToolField>
                  <ToolField label={t("translator.config.reset_orders")}>
                    <Input
                      value={preferences.memoryResetFileOrdersText}
                      disabled={disabled}
                      placeholder={t("translator.project.reset_placeholder")}
                      onChange={(e) =>
                        updatePreferences({
                          memoryResetFileOrdersText: e.target.value,
                        })
                      }
                    />
                  </ToolField>
                </div>
                <ToolField label={t("translator.config.document_background")}>
                  <Textarea
                    value={preferences.documentBackground}
                    disabled={disabled}
                    rows={3}
                    onChange={(e) =>
                      updatePreferences({
                        documentBackground: e.target.value,
                      })
                    }
                  />
                </ToolField>
                <ToolField
                  label={t("translator.config.translation_instructions")}
                >
                  <Textarea
                    value={preferences.translationInstructions}
                    disabled={disabled}
                    rows={3}
                    onChange={(e) =>
                      updatePreferences({
                        translationInstructions: e.target.value,
                      })
                    }
                  />
                </ToolField>
                <ToolField label={t("translator.config.style_instructions")}>
                  <Textarea
                    value={preferences.styleInstructions}
                    disabled={disabled}
                    rows={3}
                    onChange={(e) =>
                      updatePreferences({
                        styleInstructions: e.target.value,
                      })
                    }
                  />
                </ToolField>
                <ToolField label={t("translator.config.glossary")}>
                  <Textarea
                    value={preferences.glossaryText}
                    disabled={disabled}
                    rows={4}
                    placeholder={t(
                      "translator.project.glossary_placeholder",
                    )}
                    onChange={(e) =>
                      updatePreferences({ glossaryText: e.target.value })
                    }
                  />
                </ToolField>
              </div>
            </ToolSection>
          </>
        ) : null}

        <Separator className="my-4" />

        {/* ── Output Settings ── */}
        <ToolSection title={t("translator.sections.output")} icon={FolderOpen}>
          <div className="space-y-3">
            <ToolField label={t("translator.config.output_mode")}>
              <ButtonGroup className="w-full">
                <Button
                  size="sm"
                  className="flex-1"
                  variant={preferences.outputPathMode === "source" ? "default" : "outline"}
                  onClick={() => updatePreferences({ outputPathMode: "source" })}
                  disabled={disabled}
                >
                  {t("translator.output.source")}
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  variant={preferences.outputPathMode === "custom" ? "default" : "outline"}
                  onClick={() => updatePreferences({ outputPathMode: "custom" })}
                  disabled={disabled}
                >
                  {t("translator.output.custom")}
                </Button>
              </ButtonGroup>
            </ToolField>

            {preferences.outputPathMode === "custom" ? (
              <ToolField label={t("translator.config.output_dir")}>
                <div className="flex gap-2">
                  <Input
                    value={preferences.outputDir}
                    readOnly
                    placeholder={t("translator.output.not_selected")}
                    className="min-w-0"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={onSelectOutputPath}
                    disabled={disabled}
                    aria-label={t("translator.actions.select_output")}
                  >
                    <Folder className="h-4 w-4" />
                  </Button>
                </div>
              </ToolField>
            ) : null}

            <ToolField label={t("translator.config.conflict_policy")}>
              <ButtonGroup className="w-full">
                <Button
                  size="sm"
                  className="flex-1"
                  variant={preferences.conflictPolicy === "index" ? "default" : "outline"}
                  onClick={() => updatePreferences({ conflictPolicy: "index" })}
                  disabled={disabled}
                >
                  {t("translator.output.index")}
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  variant={preferences.conflictPolicy === "overwrite" ? "default" : "outline"}
                  onClick={() => updatePreferences({ conflictPolicy: "overwrite" })}
                  disabled={disabled}
                >
                  {t("translator.output.overwrite")}
                </Button>
              </ButtonGroup>
            </ToolField>
          </div>
        </ToolSection>
      </CardContent>
    </Card>
  );
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
