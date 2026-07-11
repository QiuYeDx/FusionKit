import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  FileAudio,
  FileText,
  FolderOpen,
  Loader2,
  Play,
  Trash2,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  InfoHint,
  ToolField,
  ToolFileDropZone,
  ToolOutputPathPicker,
  ToolPanel,
} from "@/pages/Tools/_shared/ui";
import { cn } from "@/lib/utils";
import { getFilePathFromFile } from "@/utils/filePath";
import { showToast } from "@/utils/toast";
import type {
  AudioTimestampGranularity,
  AudioTranscriptionResult,
} from "@/type/audio";
import {
  cancelAudioTranscription,
  revealAudioOutput,
  saveAudioTranscriptionResult,
  transcribeAudio,
} from "@/services/audio/audioTranscriptionService";
import AudioToolShell, {
  type AudioToolShellContext,
} from "../shared/AudioToolShell";
import useAudioTranscriberStore from "@/store/tools/audio/useAudioTranscriberStore";
import { getAudioErrorMessage } from "../shared/audioErrorMessage";
import {
  buildAudioTranscriptionRequest,
  getAudioTranscriberAccept,
  getAudioTranscriberLanguages,
  getAudioTranscriberResponseFormats,
  normalizeAudioTranscriberPreferencesForDialect,
  resolveAudioTranscriberModelMatrix,
  validateAudioTranscriberFile,
  type AudioTranscriberFileIssue,
  type SelectedAudioInput,
} from "@/store/tools/audio/audioTranscriberConfig";

const TIMESTAMP_GRANULARITIES: AudioTimestampGranularity[] = [
  "segment",
  "word",
];

export default function AudioTranscriber() {
  return (
    <AudioToolShell
      toolKey="audioTranscriber"
      assignmentKey="transcription"
      titleKey="audio:pages.transcriber.title"
      descriptionKey="audio:pages.transcriber.description"
      workspaceTitleKey="audio:pages.transcriber.workspace"
      asideExtra={(context) => <TranscriberConfig context={context} />}
    >
      {(context) => <TranscriberWorkspace context={context} />}
    </AudioToolShell>
  );
}

function TranscriberConfig({ context }: { context: AudioToolShellContext }) {
  const { t } = useTranslation(["audio"]);
  const preferences = useAudioTranscriberStore((state) => state.preferences);
  const status = useAudioTranscriberStore((state) => state.status);
  const updatePreferences = useAudioTranscriberStore(
    (state) => state.updatePreferences,
  );
  const dialect = context.configSummary.audioDialect;
  const profileContext = useMemo(
    () => ({
      audioDialect: dialect,
      provider: context.configSummary.connectionProfile?.provider,
      modelKey: context.configSummary.modelKey,
    }),
    [
      context.configSummary.connectionProfile?.provider,
      context.configSummary.modelKey,
      dialect,
    ],
  );
  const normalized = useMemo(
    () =>
      normalizeAudioTranscriberPreferencesForDialect(
        preferences,
        profileContext,
      ),
    [preferences, profileContext],
  );
  const matrix = useMemo(
    () => resolveAudioTranscriberModelMatrix(profileContext),
    [profileContext],
  );
  const responseFormats = getAudioTranscriberResponseFormats(profileContext);
  const languages = getAudioTranscriberLanguages(profileContext);
  const isMimo = dialect === "mimo_chat_audio";
  const timestampDisabled =
    !matrix.supportsTimestampGranularities ||
    normalized.responseFormat !== "verbose_json";
  const promptDisabled = !matrix.supportsPrompt;

  const handleSelectOutputDir = useCallback(async () => {
    try {
      const result = await window.ipcRenderer.invoke("select-output-directory", {
        title: t("audio:transcriber.dialog.select_output_title"),
        buttonLabel: t("audio:transcriber.dialog.select_output_confirm"),
      });
      if (result?.canceled || !result?.filePaths?.[0]) return;
      updatePreferences({
        outputMode: "custom_dir",
        outputDir: result.filePaths[0],
      });
      showToast(t("audio:transcriber.messages.output_path_selected"), "success");
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : t("audio:transcriber.errors.output_dir_select_failed"),
        "error",
      );
    }
  }, [t, updatePreferences]);

  return (
    <fieldset className="space-y-4" disabled={status === "running"}>
      <ToolField label={t("audio:transcriber.fields.language")} htmlFor="transcriber-language">
        <Select
          value={normalized.language}
          onValueChange={(language) => updatePreferences({ language })}
        >
          <SelectTrigger id="transcriber-language" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languages.map((language) => (
              <SelectItem key={language} value={language}>
                {t(`audio:transcriber.languages.${language}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ToolField>

      <ToolField
        label={t("audio:transcriber.fields.response_format")}
        htmlFor="transcriber-response-format"
        hint={
          isMimo
            ? t("audio:transcriber.hints.mimo_response_format")
            : t("audio:transcriber.hints.openai_response_format")
        }
      >
        <Select
          value={normalized.responseFormat}
          onValueChange={(responseFormat) =>
            updatePreferences({
              responseFormat: responseFormat as typeof normalized.responseFormat,
            })
          }
        >
          <SelectTrigger id="transcriber-response-format" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {responseFormats.map((format) => (
              <SelectItem key={format} value={format}>
                {t(`audio:transcriber.response_format.${format}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ToolField>

      <ToolField
        label={t("audio:transcriber.fields.timestamps")}
        hint={t("audio:transcriber.hints.timestamps")}
      >
        <div className="grid gap-2 rounded-md border px-3 py-2">
          {TIMESTAMP_GRANULARITIES.map((granularity) => {
            const checked =
              !timestampDisabled &&
              normalized.timestampGranularities.includes(granularity);
            return (
              <label
                key={granularity}
                className={cn(
                  "flex items-center gap-2 text-xs",
                  timestampDisabled && "text-muted-foreground",
                )}
              >
                <Checkbox
                  checked={checked}
                  disabled={timestampDisabled}
                  onCheckedChange={(nextChecked) => {
                    const set = new Set(normalized.timestampGranularities);
                    if (nextChecked) {
                      set.add(granularity);
                    } else {
                      set.delete(granularity);
                    }
                    updatePreferences({
                      timestampGranularities: Array.from(set),
                    });
                  }}
                />
                {t(`audio:transcriber.timestamp.${granularity}`)}
              </label>
            );
          })}
        </div>
      </ToolField>

      <ToolField
        label={t("audio:transcriber.fields.prompt")}
        htmlFor="transcriber-prompt"
        hint={t("audio:transcriber.hints.prompt")}
      >
        <Textarea
          id="transcriber-prompt"
          value={promptDisabled ? "" : preferences.prompt}
          disabled={promptDisabled}
          rows={3}
          className="resize-none text-xs"
          placeholder={
            promptDisabled
              ? t("audio:transcriber.placeholders.mimo_prompt_disabled")
              : t("audio:transcriber.placeholders.prompt")
          }
          onChange={(event) =>
            updatePreferences({ prompt: event.currentTarget.value })
          }
        />
      </ToolField>

      <ToolField
        label={t("audio:transcriber.fields.stream")}
        hint={t("audio:transcriber.hints.stream")}
        action={
          <Switch
            checked={normalized.stream}
            disabled={!matrix.supportsStream}
            aria-label={t("audio:transcriber.fields.stream")}
            onCheckedChange={(stream) => updatePreferences({ stream })}
          />
        }
      >
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(
            matrix.supportsStream
              ? "audio:transcriber.hints.stream_enabled"
              : "audio:transcriber.hints.stream_disabled",
          )}
        </p>
      </ToolField>

      <ToolField
        label={t("audio:transcriber.fields.output_mode")}
        hint={t("audio:transcriber.hints.output_mode")}
      >
        <ButtonGroup className="w-full" role="radiogroup" aria-label={t("audio:transcriber.fields.output_mode")}>
          {(["display_only", "source_dir", "custom_dir"] as const).map(
            (mode) => (
              <Button
                key={mode}
                type="button"
                role="radio"
                aria-checked={preferences.outputMode === mode}
                size="sm"
                className="flex-1"
                variant={preferences.outputMode === mode ? "default" : "outline"}
                onClick={() => updatePreferences({ outputMode: mode })}
              >
                {t(`audio:transcriber.output_mode.${mode}`)}
              </Button>
            ),
          )}
        </ButtonGroup>
        {preferences.outputMode === "custom_dir" ? (
          <ToolOutputPathPicker
            className="mt-2"
            value={preferences.outputDir}
            placeholder={t("audio:transcriber.placeholders.output_dir")}
            selectLabel={t("audio:transcriber.actions.select_output_dir")}
            onSelect={handleSelectOutputDir}
          />
        ) : null}
      </ToolField>
    </fieldset>
  );
}

function TranscriberWorkspace({ context }: { context: AudioToolShellContext }) {
  const { t } = useTranslation(["audio", "common"]);
  const preferences = useAudioTranscriberStore((state) => state.preferences);
  const selectedFile = useAudioTranscriberStore((state) => state.selectedFile);
  const result = useAudioTranscriberStore((state) => state.result);
  const status = useAudioTranscriberStore((state) => state.status);
  const lastError = useAudioTranscriberStore((state) => state.lastError);
  const activeRequestId = useAudioTranscriberStore(
    (state) => state.activeRequestId,
  );
  const setSelectedFile = useAudioTranscriberStore(
    (state) => state.setSelectedFile,
  );
  const setResult = useAudioTranscriberStore((state) => state.setResult);
  const setStatus = useAudioTranscriberStore((state) => state.setStatus);
  const setLastError = useAudioTranscriberStore((state) => state.setLastError);
  const seedProfileDefaults = useAudioTranscriberStore(
    (state) => state.seedProfileDefaults,
  );
  const beginRequest = useAudioTranscriberStore((state) => state.beginRequest);
  const invalidateActiveRequest = useAudioTranscriberStore(
    (state) => state.invalidateActiveRequest,
  );
  const isRequestCurrent = useAudioTranscriberStore(
    (state) => state.isRequestCurrent,
  );
  const resetTaskState = useAudioTranscriberStore(
    (state) => state.resetTaskState,
  );
  const dialect = context.configSummary.audioDialect;
  const profileContext = useMemo(
    () => ({
      audioDialect: dialect,
      provider: context.configSummary.connectionProfile?.provider,
      modelKey: context.configSummary.modelKey,
    }),
    [
      context.configSummary.connectionProfile?.provider,
      context.configSummary.modelKey,
      dialect,
    ],
  );
  useEffect(() => {
    if (!context.configSummary.profileId) return;
    seedProfileDefaults(
      context.configSummary.profileId,
      context.configSummary.defaults ?? {},
    );
  }, [
    context.configSummary.defaults,
    context.configSummary.profileId,
    seedProfileDefaults,
  ]);
  const normalized = useMemo(
    () =>
      normalizeAudioTranscriberPreferencesForDialect(
        preferences,
        profileContext,
      ),
    [preferences, profileContext],
  );
  const submitIssue = useMemo(
    () => {
      const issueKey = resolveSubmitIssueKey(context, selectedFile, normalized);
      return issueKey ? t(issueKey) : null;
    },
    [context, normalized, selectedFile, t],
  );
  const isRunning = status === "running";

  useEffect(() => {
    return () => {
      const invalidated =
        useAudioTranscriberStore.getState().invalidateActiveRequest("cancelled");
      if (invalidated) {
        void cancelAudioTranscription(invalidated.requestId);
      }
    };
  }, []);

  const handleFiles = useCallback(
    (files: FileList) => {
      const file = files[0];
      if (!file) return;

      const validation = validateAudioTranscriberFile(file, dialect);
      if (!validation.ok) {
        const message = getFileIssueMessage(t, validation.issue);
        setLastError({
          code: "renderer_error",
          message,
          field: "file",
          details: validation.issue.details,
        });
        showToast(message, "error");
        return;
      }

      void window.audioApi.authorizeInputFile(file).then((authorization) => {
        if (!authorization.ok) {
          const message = authorization.error.message ||
            t("audio:transcriber.errors.file_path_unavailable");
          setLastError({
            code: authorization.error.code,
            message,
            field: authorization.error.field ?? "file",
            details: authorization.error.details,
          });
          showToast(message, "error");
          return;
        }

        const nextFile: SelectedAudioInput = {
          fileName: authorization.data.fileName || file.name,
          filePath: getFilePathFromFile(file) || file.name,
          fileToken: authorization.data.fileToken,
          mimeType: validation.mimeType,
          sizeBytes: authorization.data.sizeBytes,
          modifiedAt: file.lastModified,
        };
        setSelectedFile(nextFile);
        showToast(t("audio:transcriber.messages.file_selected"), "success");
      });
    },
    [dialect, setLastError, setSelectedFile, t],
  );

  const handleStart = useCallback(async () => {
    const issueKey = resolveSubmitIssueKey(context, selectedFile, normalized);
    if (issueKey) {
      const message = t(issueKey);
      showToast(message, "error");
      setLastError({ code: "renderer_error", message });
      return;
    }
    if (!selectedFile) return;

    const requestId = createTranscriptionRequestId();
    const request = buildAudioTranscriptionRequest({
      requestId,
      file: selectedFile,
      preferences: normalized,
      dialect,
      provider: profileContext.provider,
      modelKey: profileContext.modelKey,
    });
    const generation = beginRequest(requestId);

    const response = await transcribeAudio(request);
    if (!isRequestCurrent(requestId, generation)) return;

    invalidateActiveRequest("idle");
    if (response.ok) {
      setResult(response.data);
      setStatus("completed");
      showToast(t("audio:transcriber.messages.completed"), "success");
      return;
    }

    setStatus("failed");
    setLastError({
      code: response.error.code,
      message: response.error.message,
      field: response.error.field,
      details: response.error.details,
    });
    showToast(response.error.message, "error");
  }, [
    context,
    beginRequest,
    dialect,
    invalidateActiveRequest,
    isRequestCurrent,
    normalized,
    profileContext.modelKey,
    profileContext.provider,
    selectedFile,
    setLastError,
    setResult,
    setStatus,
    t,
  ]);

  const handleCancel = useCallback(async () => {
    if (!activeRequestId) return;
    const invalidated = invalidateActiveRequest("cancelled");
    if (!invalidated) return;
    const response = await cancelAudioTranscription(invalidated.requestId);
    if (
      useAudioTranscriberStore.getState().requestGeneration !==
      invalidated.generation
    ) {
      return;
    }
    if (response.ok && response.data.cancelled) {
      showToast(t("audio:transcriber.messages.cancelled"), "success");
      return;
    }
    const message = response.ok
      ? t("audio:transcriber.errors.cancel_failed")
      : response.error.message;
    setStatus("failed");
    setLastError({
      code: response.ok ? "renderer_error" : response.error.code,
      message,
      ...(response.ok ? {} : { field: response.error.field }),
    });
    showToast(message, "error");
  }, [
    activeRequestId,
    invalidateActiveRequest,
    setLastError,
    setStatus,
    t,
  ]);

  const handleCopy = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(getResultDisplayText(result));
      showToast(t("audio:transcriber.messages.copied"), "success");
    } catch {
      showToast(t("audio:transcriber.errors.copy_failed"), "error");
    }
  }, [result, t]);

  const handleReveal = useCallback(async () => {
    if (!result?.outputToken) {
      showToast(t("audio:transcriber.errors.output_not_ready"), "error");
      return;
    }
    const response = await revealAudioOutput({ outputToken: result.outputToken });
    if (!response.ok) {
      showToast(response.error.message, "error");
    }
  }, [result?.outputToken, t]);

  const handleSave = useCallback(async () => {
    if (!result) return;
    const response = await saveAudioTranscriptionResult(
      result,
      selectedFile?.fileName,
    );
    if (response.ok) {
      if (response.data.saved) {
        showToast(t("audio:transcriber.messages.saved"), "success");
      }
      return;
    }
    showToast(
      response.error.message || t("audio:transcriber.errors.save_failed"),
      "error",
    );
  }, [result, selectedFile?.fileName, t]);

  return (
    <ToolPanel
      icon={FileAudio}
      title={t("audio:pages.transcriber.workspace")}
      badge={<TranscriberStatusBadge status={status} />}
      bodyClassName="p-5"
    >
      <div className="space-y-4">
        {context.configSummary.status !== "ready" ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>
              {t(`audio:workspace.${context.configSummary.status}.title`)}
            </AlertTitle>
            <AlertDescription>
              {t(`audio:workspace.${context.configSummary.status}.description`)}
            </AlertDescription>
          </Alert>
        ) : null}

        <ToolFileDropZone
          accept={getAudioTranscriberAccept(dialect)}
          disabled={isRunning}
          title={t("audio:transcriber.file.title")}
          description={
            dialect === "mimo_chat_audio"
              ? t("audio:transcriber.file.mimo_description")
              : t("audio:transcriber.file.openai_description")
          }
          actionLabel={t("audio:transcriber.actions.select_file")}
          onFiles={handleFiles}
        />

        {selectedFile ? (
          <SelectedFileCard
            file={selectedFile}
            disabled={isRunning}
            onClear={() => {
              setSelectedFile(null);
              resetTaskState();
            }}
          />
        ) : null}

        {lastError ? (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertTitle>{t("audio:transcriber.errors.title")}</AlertTitle>
            <AlertDescription>
              <div className="space-y-1">
                <div>{getAudioErrorMessage(t, lastError, lastError.message)}</div>
                <div className="font-mono text-[11px]">code: {lastError.code}</div>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={Boolean(submitIssue) || isRunning}
            onClick={handleStart}
            className="gap-1.5"
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {isRunning
              ? t("audio:transcriber.actions.running")
              : t("audio:transcriber.actions.start")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!isRunning}
            onClick={handleCancel}
            className="gap-1.5"
          >
            <XCircle className="h-4 w-4" />
            {t("common:action.cancel")}
          </Button>
          {submitIssue ? (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <InfoHint>{submitIssue}</InfoHint>
              <span className="truncate">{submitIssue}</span>
            </div>
          ) : null}
        </div>

        <ResultPanel
          result={result}
          status={status}
          onCopy={handleCopy}
          onReveal={handleReveal}
          onSave={handleSave}
        />
      </div>
    </ToolPanel>
  );
}

function SelectedFileCard({
  file,
  disabled,
  onClear,
}: {
  file: SelectedAudioInput;
  disabled: boolean;
  onClear: () => void;
}) {
  const { t } = useTranslation(["audio"]);
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
        <FileAudio className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{file.fileName}</div>
        <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <span>{file.mimeType}</span>
          <span>{formatBytes(file.sizeBytes)}</span>
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        onClick={onClear}
        aria-label={t("audio:transcriber.actions.clear_file")}
        title={t("audio:transcriber.actions.clear_file")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function ResultPanel({
  result,
  status,
  onCopy,
  onReveal,
  onSave,
}: {
  result: AudioTranscriptionResult | null;
  status: string;
  onCopy: () => void;
  onReveal: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation(["audio"]);
  if (!result) {
    return (
      <div className="flex min-h-[220px] items-center justify-center rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center">
        <div className="max-w-md space-y-3">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full border bg-background text-muted-foreground">
            {status === "running" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
          </div>
          <div className="text-sm font-medium">
            {t(`audio:transcriber.empty.${status === "running" ? "running" : "title"}`)}
          </div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            {t(
              `audio:transcriber.empty.${status === "running" ? "running_description" : "description"}`,
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {t("audio:transcriber.result.title")}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span>{t(`audio:transcriber.response_format.${result.responseFormat}`)}</span>
            {result.model ? <span>{result.model}</span> : null}
            {result.outputPath ? (
              <span className="truncate">{result.outputPath}</span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCopy}>
            <Clipboard className="h-3.5 w-3.5" />
            {t("audio:transcriber.actions.copy")}
          </Button>
          {result.outputPath ? (
            <Button type="button" variant="outline" size="sm" onClick={onReveal}>
              <FolderOpen className="h-3.5 w-3.5" />
              {t("audio:transcriber.actions.open_output")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSave}
            >
              <Download className="h-3.5 w-3.5" />
              {t("audio:transcriber.actions.save_result")}
            </Button>
          )}
        </div>
      </div>
      <Textarea
        readOnly
        value={getResultDisplayText(result)}
        className="min-h-[220px] resize-y font-mono text-xs leading-relaxed"
      />
    </div>
  );
}

function TranscriberStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation(["audio"]);
  const tone =
    status === "completed"
      ? "border-emerald-500/25 text-emerald-700 dark:text-emerald-300"
      : status === "failed" || status === "cancelled"
        ? "border-amber-500/25 text-amber-700 dark:text-amber-300"
        : "";
  const Icon =
    status === "running"
      ? Loader2
      : status === "completed"
        ? CheckCircle2
        : status === "failed" || status === "cancelled"
          ? AlertTriangle
          : FileText;
  return (
    <Badge variant="outline" className={cn("gap-1", tone)}>
      <Icon className={cn("h-3 w-3", status === "running" && "animate-spin")} />
      {t(`audio:transcriber.status.${status}`)}
    </Badge>
  );
}

function resolveSubmitIssueKey(
  context: AudioToolShellContext,
  selectedFile: SelectedAudioInput | null,
  preferences: ReturnType<typeof normalizeAudioTranscriberPreferencesForDialect>,
): string | null {
  if (context.configSummary.status !== "ready") {
    return `audio:workspace.${context.configSummary.status}.title`;
  }
  const matrix = resolveAudioTranscriberModelMatrix({
    audioDialect: context.configSummary.audioDialect,
    provider: context.configSummary.connectionProfile?.provider,
    modelKey: context.configSummary.modelKey,
  });
  if (!matrix.modelSupported) {
    return "audio:transcriber.errors.unsupported_model";
  }
  if (!selectedFile) {
    return "audio:transcriber.errors.no_file";
  }
  const validation = validateAudioTranscriberFile(
    {
      name: selectedFile.fileName,
      type: selectedFile.mimeType,
      size: selectedFile.sizeBytes,
    } as Pick<File, "name" | "type" | "size">,
    context.configSummary.audioDialect,
  );
  if (!validation.ok) {
    return `audio:transcriber.errors.${validation.issue.code}`;
  }
  if (preferences.outputMode === "custom_dir" && !preferences.outputDir.trim()) {
    return "audio:transcriber.errors.output_dir_required";
  }
  return null;
}

function getFileIssueMessage(
  t: (key: string) => string,
  issue: AudioTranscriberFileIssue,
): string {
  return t(`audio:transcriber.errors.${issue.code}`);
}

function getResultDisplayText(result: AudioTranscriptionResult): string {
  if (
    (result.responseFormat === "json" ||
      result.responseFormat === "verbose_json") &&
    result.rawJson
  ) {
    return JSON.stringify(result.rawJson, null, 2);
  }
  return result.rawText ?? result.text;
}

function createTranscriptionRequestId(): string {
  return `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
