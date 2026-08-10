import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Cpu,
  ChevronDown,
  Download,
  FileInput,
  HardDrive,
  Loader2,
  RefreshCw,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  ToolPanel,
  ToolRadioButtonGroup,
} from "@/pages/Tools/_shared/ui";
import {
  LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
  type LocalSubtitleResourceJobStatus,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleResourceType,
} from "@/type/localSubtitle";
import type {
  LocalSubtitleBackendPreviewSummary,
  LocalSubtitleManagedResourceSummary,
  LocalSubtitleRuntimeSummary,
} from "@/type/localSubtitleIpc";
import {
  formatLocalSubtitleBytes,
  getInstalledLocalSubtitleResourceBytes,
  getLatestLocalSubtitleResourceJobs,
  isLocalSubtitleResourceJobActive,
} from "./localSubtitleTranscriberModel";
import {
  LocalSubtitleErrorNotice,
  type LocalSubtitleDisplayError,
} from "./LocalSubtitleErrorNotice";

const RESOURCE_TYPE_KEYS = {
  model: "subtitle:local_transcriber.resources.type.model",
  vad: "subtitle:local_transcriber.resources.type.vad",
  accelerator: "subtitle:local_transcriber.resources.type.accelerator",
} as const satisfies Record<LocalSubtitleResourceType, string>;

const RESOURCE_STATUS_KEYS = {
  not_installed: "subtitle:local_transcriber.resources.status.not_installed",
  installing: "subtitle:local_transcriber.resources.status.installing",
  ready: "subtitle:local_transcriber.resources.status.ready",
  invalid: "subtitle:local_transcriber.resources.status.invalid",
} as const satisfies Record<
  LocalSubtitleManagedResourceSummary["status"],
  string
>;

const RESOURCE_JOB_STATUS_KEYS = {
  queued: "subtitle:local_transcriber.resources.job.queued",
  acquiring: "subtitle:local_transcriber.resources.job.acquiring",
  verifying: "subtitle:local_transcriber.resources.job.verifying",
  load_smoke: "subtitle:local_transcriber.resources.job.load_smoke",
  signature_check: "subtitle:local_transcriber.resources.job.signature_check",
  committing: "subtitle:local_transcriber.resources.job.committing",
  completed: "subtitle:local_transcriber.resources.job.completed",
  cancelling: "subtitle:local_transcriber.resources.job.cancelling",
  cancelled: "subtitle:local_transcriber.resources.job.cancelled",
  failed: "subtitle:local_transcriber.resources.job.failed",
} as const satisfies Record<LocalSubtitleResourceJobStatus, string>;

const BACKEND_KEYS = {
  cpu: "subtitle:local_transcriber.environment.backend.cpu",
  cuda: "subtitle:local_transcriber.environment.backend.cuda",
  metal: "subtitle:local_transcriber.environment.backend.metal",
} as const satisfies Record<
  LocalSubtitleRuntimeSummary["backends"][number]["backend"],
  string
>;

const BACKENDS = ["cpu", "cuda", "metal"] as const;

export type LocalSubtitleResourceActionKind =
  | "install"
  | "cancel"
  | "delete"
  | "import";

export function localSubtitleResourceActionKey(
  kind: LocalSubtitleResourceActionKind,
  target: string,
): string {
  return `${kind}:${target}`;
}

interface LocalSubtitleEnvironmentManagerProps {
  readonly loading: boolean;
  readonly runtime: LocalSubtitleRuntimeSummary | null;
  readonly backendPreviewStatus: "idle" | "loading" | "ready" | "error";
  readonly backendPreview: LocalSubtitleBackendPreviewSummary | null;
  readonly resources: readonly LocalSubtitleManagedResourceSummary[];
  readonly resourceJobs: readonly LocalSubtitleResourceJobSummary[];
  readonly pendingActionKeys: ReadonlySet<string>;
  readonly environmentError: LocalSubtitleDisplayError | null;
  readonly resourceActionError: LocalSubtitleDisplayError | null;
  readonly onRefresh: () => void;
  readonly onInstall: (resourceId: string) => Promise<boolean>;
  readonly onCancel: (jobId: string) => Promise<boolean>;
  readonly onDelete: (resourceId: string) => Promise<boolean>;
  readonly onImport: (file: File, mode: "copy" | "move") => Promise<boolean>;
}

export function LocalSubtitleEnvironmentManager({
  loading,
  runtime,
  backendPreviewStatus,
  backendPreview,
  resources,
  resourceJobs,
  pendingActionKeys,
  environmentError,
  resourceActionError,
  onRefresh,
  onInstall,
  onCancel,
  onDelete,
  onImport,
}: LocalSubtitleEnvironmentManagerProps) {
  const { t } = useTranslation(["subtitle", "common"]);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importMode, setImportMode] = useState<"copy" | "move">("copy");
  const [deleteTarget, setDeleteTarget] =
    useState<LocalSubtitleManagedResourceSummary | null>(null);
  const latestJobs = useMemo(
    () => getLatestLocalSubtitleResourceJobs(resourceJobs),
    [resourceJobs],
  );
  const installedBytes = getInstalledLocalSubtitleResourceBytes(resources);
  const readyCount = resources.filter(
    (resource) => resource.status === "ready",
  ).length;
  const modelResource = resources.find(
    (resource) => resource.resourceType === "model",
  );
  const modelJob = modelResource
    ? latestJobs.get(modelResource.resourceId) ?? null
    : null;
  const importPending = pendingActionKeys.has(
    localSubtitleResourceActionKey("import", modelResource?.resourceId ?? "model"),
  );
  const importDisabled =
    loading ||
    !modelResource ||
    modelResource.status === "ready" ||
    isLocalSubtitleResourceJobActive(modelJob) ||
    importPending;
  const runtimeError = environmentError ?? runtimeSummaryError(runtime);
  const hasActiveResourceJob = resources.some((resource) =>
    isLocalSubtitleResourceJobActive(
      latestJobs.get(resource.resourceId) ?? null,
    ),
  );
  const managerNeedsAttention = Boolean(
    runtimeError ||
    resourceActionError ||
    hasActiveResourceJob ||
    (modelResource && modelResource.status !== "ready"),
  );
  const [managerOpen, setManagerOpen] = useState(false);
  const [runtimeDetailsOpen, setRuntimeDetailsOpen] = useState(false);

  useEffect(() => {
    if (managerNeedsAttention) setManagerOpen(true);
  }, [managerNeedsAttention]);

  const submitImport = async () => {
    if (!importFile || importDisabled) return;
    if (await onImport(importFile, importMode)) {
      setImportFile(null);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const submitDelete = async () => {
    if (!deleteTarget) return;
    if (await onDelete(deleteTarget.resourceId)) setDeleteTarget(null);
  };

  return (
    <>
      <ToolPanel
        icon={Server}
        title={t("subtitle:local_transcriber.environment.title")}
        headerClassName={managerOpen ? undefined : "border-b-0"}
        badge={
          <div className="flex items-center gap-1.5">
            <EnvironmentStatusBadge loading={loading} runtime={runtime} />
            <Badge variant="outline">
              {t("subtitle:local_transcriber.resources.ready_count", {
                ready: readyCount,
                total: resources.length,
              })}
            </Badge>
          </div>
        }
        actions={
          <>
            <input
              ref={importInputRef}
              id="local-subtitle-model-import"
              data-testid="local-subtitle-model-import-input"
              type="file"
              accept=".bin,application/octet-stream"
              className="sr-only"
              disabled={importDisabled}
              onChange={(event) =>
                setImportFile(event.target.files?.item(0) ?? null)
              }
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={importDisabled}
              onClick={() => importInputRef.current?.click()}
            >
              <FileInput className="h-3.5 w-3.5" />
              {t("subtitle:local_transcriber.actions.import_model")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={loading}
              onClick={onRefresh}
              aria-label={t("subtitle:local_transcriber.actions.refresh")}
              title={t("subtitle:local_transcriber.actions.refresh")}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-expanded={managerOpen}
              aria-label={t("subtitle:local_transcriber.resources.title")}
              title={t("subtitle:local_transcriber.resources.title")}
              onClick={() => setManagerOpen((open) => !open)}
            >
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform duration-150 motion-reduce:transition-none ${managerOpen ? "rotate-180" : ""}`}
              />
            </Button>
          </>
        }
      >
        {managerOpen ? (
          <div data-testid="local-subtitle-environment-manager">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-4 py-2.5 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <HardDrive className="h-3.5 w-3.5" />
                {t("subtitle:local_transcriber.resources.managed_only")}
              </span>
              <span className="font-mono tabular-nums">
                {t("subtitle:local_transcriber.resources.disk_usage", {
                  size: formatLocalSubtitleBytes(installedBytes),
                })}
              </span>
            </div>

            {runtimeError ? (
              <EnvironmentErrorNotice error={runtimeError} />
            ) : null}

            {resourceActionError ? (
              <div className="px-4 pt-4">
                <LocalSubtitleErrorNotice error={resourceActionError} />
              </div>
            ) : null}

            <div className="divide-y">
              {resources.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  {t(
                    loading
                      ? "subtitle:local_transcriber.resources.loading"
                      : "subtitle:local_transcriber.resources.empty",
                  )}
                </div>
              ) : (
                resources.map((resource) => (
                  <ResourceRow
                    key={resource.resourceId}
                    resource={resource}
                    job={latestJobs.get(resource.resourceId) ?? null}
                    pendingActionKeys={pendingActionKeys}
                    onInstall={onInstall}
                    onCancel={onCancel}
                    onDelete={() => setDeleteTarget(resource)}
                  />
                ))
              )}
            </div>

            <section className="border-t">
              <button
                type="button"
                data-testid="local-subtitle-runtime-toggle"
                className="flex w-full min-w-0 items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none"
                aria-expanded={runtimeDetailsOpen}
                aria-controls="local-subtitle-runtime-details"
                onClick={() => setRuntimeDetailsOpen((open) => !open)}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium leading-5">
                      {t("subtitle:local_transcriber.environment.runtime_details")}
                    </span>
                    <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                      {runtime
                        ? `${runtime.platform} · ${runtime.arch}`
                        : t("subtitle:local_transcriber.environment.not_ready")}
                    </span>
                  </span>
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${runtimeDetailsOpen ? "rotate-180" : ""}`}
                />
              </button>
              {runtimeDetailsOpen ? (
                <div id="local-subtitle-runtime-details" className="border-t">
                  <RuntimeSummary
                    runtime={runtime}
                    loading={loading}
                    backendPreviewStatus={backendPreviewStatus}
                    backendPreview={backendPreview}
                  />
                </div>
              ) : null}
            </section>
          </div>
        ) : null}
      </ToolPanel>

      <Dialog
        open={Boolean(importFile)}
        onOpenChange={(open) => {
          if (!open && !importPending) {
            setImportFile(null);
            if (importInputRef.current) importInputRef.current.value = "";
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("subtitle:local_transcriber.resources.import.title")}
            </DialogTitle>
            <DialogDescription>
              {t("subtitle:local_transcriber.resources.import.description")}
            </DialogDescription>
          </DialogHeader>
          {importFile ? (
            <div className="min-w-0 space-y-4">
              <div className="min-w-0 border-y py-3">
                <div className="break-words text-sm font-medium [overflow-wrap:anywhere]">
                  {importFile.name}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t("subtitle:local_transcriber.resources.import.estimated_usage", {
                    size: formatLocalSubtitleBytes(importFile.size),
                  })}
                </div>
              </div>
              <ToolRadioButtonGroup
                value={importMode}
                disabled={importPending}
                ariaLabel={t("subtitle:local_transcriber.resources.import.mode")}
                options={[
                  {
                    value: "copy",
                    label: t("subtitle:local_transcriber.resources.import.copy"),
                  },
                  {
                    value: "move",
                    label: t("subtitle:local_transcriber.resources.import.move"),
                  },
                ]}
                onValueChange={setImportMode}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t(
                  importMode === "copy"
                    ? "subtitle:local_transcriber.resources.import.copy_hint"
                    : "subtitle:local_transcriber.resources.import.move_hint",
                )}
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={importPending}>
                {t("common:action.cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={!importFile || importPending}
              onClick={submitImport}
            >
              {importPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileInput className="h-4 w-4" />
              )}
              {t("subtitle:local_transcriber.actions.import_model")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (
            !open &&
            deleteTarget &&
            !pendingActionKeys.has(
              localSubtitleResourceActionKey("delete", deleteTarget.resourceId),
            )
          ) {
            setDeleteTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("subtitle:local_transcriber.resources.delete.title")}
            </DialogTitle>
            <DialogDescription className="break-words [overflow-wrap:anywhere]">
              {t("subtitle:local_transcriber.resources.delete.description", {
                name: deleteTarget?.displayName ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common:action.cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={!deleteTarget || pendingActionKeys.has(
                localSubtitleResourceActionKey("delete", deleteTarget.resourceId),
              )}
              onClick={submitDelete}
            >
              {deleteTarget && pendingActionKeys.has(
                localSubtitleResourceActionKey("delete", deleteTarget.resourceId),
              ) ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {t("subtitle:local_transcriber.actions.delete_resource")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function EnvironmentErrorNotice({
  error,
}: {
  error: LocalSubtitleDisplayError;
}) {
  const { t } = useTranslation(["subtitle"]);
  const messageKey = environmentErrorMessageKey(error.code);
  return (
    <div className="border-t p-4">
      <LocalSubtitleErrorNotice
        error={{
          code: error.code,
          message: t(messageKey),
        }}
        guidance={t("subtitle:local_transcriber.environment.error.recovery")}
      />
    </div>
  );
}

function environmentErrorMessageKey(code: string | undefined) {
  switch (code) {
    case "unsupported_platform":
      return "subtitle:local_transcriber.environment.error.unsupported_platform";
    case "unsupported_architecture":
      return "subtitle:local_transcriber.environment.error.unsupported_architecture";
    case "runtime_missing":
      return "subtitle:local_transcriber.environment.error.runtime_missing";
    case "runtime_protocol_mismatch":
      return "subtitle:local_transcriber.environment.error.runtime_protocol_mismatch";
    case "media_runtime_missing":
      return "subtitle:local_transcriber.environment.error.media_runtime_missing";
    case "media_runtime_invalid":
      return "subtitle:local_transcriber.environment.error.media_runtime_invalid";
    case "media_runtime_launch_failed":
      return "subtitle:local_transcriber.environment.error.media_runtime_launch_failed";
    default:
      return "subtitle:local_transcriber.environment.error.unknown";
  }
}

function runtimeSummaryError(
  runtime: LocalSubtitleRuntimeSummary | null,
): LocalSubtitleDisplayError | null {
  if (!runtime) return null;
  const cpu = runtime.backends.find((backend) => backend.backend === "cpu");
  const code = runtime.runner.status !== "ready"
    ? runtime.runner.errorCode
    : runtime.mediaRuntime.status !== "ready"
      ? runtime.mediaRuntime.errorCode
      : cpu?.status !== "available"
        ? cpu?.errorCode
        : undefined;
  return code ? { code, message: "" } : null;
}

function RuntimeSummary({
  runtime,
  loading,
  backendPreviewStatus,
  backendPreview,
}: {
  runtime: LocalSubtitleRuntimeSummary | null;
  loading: boolean;
  backendPreviewStatus: "idle" | "loading" | "ready" | "error";
  backendPreview: LocalSubtitleBackendPreviewSummary | null;
}) {
  const { t } = useTranslation(["subtitle"]);
  const unavailableValue = loading
    ? t("subtitle:local_transcriber.environment.checking")
    : t("subtitle:local_transcriber.environment.not_ready");
  const values = [
    {
      label: t("subtitle:local_transcriber.environment.platform"),
      value: runtime ? `${runtime.platform} · ${runtime.arch}` : unavailableValue,
    },
    {
      label: t("subtitle:local_transcriber.environment.contract"),
      value: runtime
        ? `HTTP v${LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION}`
        : unavailableValue,
    },
    {
      label: t("subtitle:local_transcriber.environment.runner"),
      value:
        runtime?.runner.version ??
        runtime?.runner.errorCode ??
        unavailableValue,
    },
    {
      label: t("subtitle:local_transcriber.environment.ffmpeg"),
      value:
        runtime?.mediaRuntime.version ??
        runtime?.mediaRuntime.errorCode ??
        unavailableValue,
    },
  ];

  return (
    <div
      data-testid="local-subtitle-runtime-summary"
      className="min-w-0 bg-muted/[0.08]"
    >
      <dl className="divide-y px-4">
        {values.map((item) => (
          <div
            key={item.label}
            className="grid min-w-0 grid-cols-[minmax(6.5rem,0.4fr)_minmax(0,1fr)] items-baseline gap-x-5 py-2.5"
          >
            <dt className="text-xs leading-5 text-muted-foreground">
              {item.label}
            </dt>
            <dd className="min-w-0 break-words text-right font-mono text-xs leading-5 [overflow-wrap:anywhere]">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>

      <section className="border-t" aria-labelledby="local-subtitle-backends-title">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-5 gap-y-1 px-4 py-3">
          <h4
            id="local-subtitle-backends-title"
            className="text-xs font-medium leading-5"
          >
            {t("subtitle:local_transcriber.environment.backends")}
          </h4>
          <p className="min-w-0 break-words text-right text-[11px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {backendPreviewStatus === "ready" && backendPreview
              ? t("subtitle:local_transcriber.environment.execution_profile", {
                  preference: backendPreview.devicePreference.toUpperCase(),
                  backend: backendPreview.resolvedBackend.toUpperCase(),
                  version: backendPreview.serverVersion,
                })
              : backendPreviewStatus === "loading"
                ? t("subtitle:local_transcriber.environment.resolving_backend")
                : t("subtitle:local_transcriber.environment.unavailable_short")}
          </p>
        </div>
        {runtime ? (
          <ul className="divide-y border-t">
            {BACKENDS.map((backendId) => {
              const backend = runtime.backends.find(
                (entry) => entry.backend === backendId,
              );
              return (
                <li
                  key={backendId}
                  className="grid min-w-0 grid-cols-[minmax(4.5rem,0.32fr)_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5"
                >
                  <span className="text-xs font-medium leading-5">
                    {t(BACKEND_KEYS[backendId])}
                  </span>
                  <span className="min-w-0 whitespace-pre-wrap break-words font-mono text-[10.5px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
                    {backend?.errorCode ?? ""}
                  </span>
                  <BackendStatus status={backend?.status ?? null} />
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="border-t px-4 py-5 text-center text-xs text-muted-foreground">
            {t("subtitle:local_transcriber.environment.no_backend_data")}
          </div>
        )}
      </section>
    </div>
  );
}

function ResourceRow({
  resource,
  job,
  pendingActionKeys,
  onInstall,
  onCancel,
  onDelete,
}: {
  resource: LocalSubtitleManagedResourceSummary;
  job: LocalSubtitleResourceJobSummary | null;
  pendingActionKeys: ReadonlySet<string>;
  onInstall: (resourceId: string) => Promise<boolean>;
  onCancel: (jobId: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["subtitle"]);
  const activeJob = isLocalSubtitleResourceJobActive(job);
  const installPending = pendingActionKeys.has(
    localSubtitleResourceActionKey("install", resource.resourceId),
  );
  const cancelPending = Boolean(
    job && pendingActionKeys.has(
      localSubtitleResourceActionKey("cancel", job.jobId),
    ),
  );
  const canInstall =
    !activeJob &&
    (resource.status === "not_installed" || resource.status === "invalid");
  const canDelete =
    !activeJob &&
    (resource.status === "ready" || resource.status === "invalid");

  return (
    <div
      data-testid={`local-subtitle-resource-${resource.resourceId}`}
      className="min-w-0 px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">
              {resource.displayName}
            </span>
            <ResourceStatusBadge resource={resource} />
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
            <span>{t(RESOURCE_TYPE_KEYS[resource.resourceType])}</span>
            <span aria-hidden="true">·</span>
            <span>{formatLocalSubtitleBytes(resource.byteSize)}</span>
            {resource.version ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{resource.version}</span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <span>
              {resource.compatibleBackends
                .map((backend) => backend.toUpperCase())
                .join(" / ")}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {activeJob && job ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={cancelPending || job.status === "cancelling"}
              onClick={() => void onCancel(job.jobId)}
              aria-label={t("subtitle:local_transcriber.actions.cancel_resource", {
                name: resource.displayName,
              })}
              title={t("subtitle:local_transcriber.actions.cancel_resource", {
                name: resource.displayName,
              })}
            >
              {cancelPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
            </Button>
          ) : null}
          {canInstall ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={installPending}
              onClick={() => void onInstall(resource.resourceId)}
              aria-label={t("subtitle:local_transcriber.actions.install_resource", {
                name: resource.displayName,
              })}
              title={t("subtitle:local_transcriber.actions.install_resource", {
                name: resource.displayName,
              })}
            >
              {installPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onDelete}
              aria-label={t(
                "subtitle:local_transcriber.actions.delete_named_resource",
                { name: resource.displayName },
              )}
              title={t(
                "subtitle:local_transcriber.actions.delete_named_resource",
                { name: resource.displayName },
              )}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {activeJob && job ? (
        <div className="mt-3 space-y-1.5">
          <div className="flex min-w-0 items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <span>{t(RESOURCE_JOB_STATUS_KEYS[job.status])}</span>
            <span className="shrink-0 font-mono tabular-nums">
              {job.bytesTotal !== undefined && job.bytesCompleted !== undefined
                ? `${formatLocalSubtitleBytes(job.bytesCompleted)} / ${formatLocalSubtitleBytes(job.bytesTotal)}`
                : `${Math.round(job.progress)}%`}
            </span>
          </div>
          <Progress value={job.progress} />
        </div>
      ) : null}

      {job?.status === "failed" && job.error ? (
        <div className="mt-3">
          <LocalSubtitleErrorNotice error={job.error} />
        </div>
      ) : null}
      {resource.errorCode ? (
        <div className="mt-2 whitespace-pre-wrap break-words rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 font-mono text-[10.5px] text-muted-foreground [overflow-wrap:anywhere]">
          {resource.errorCode}
        </div>
      ) : null}
    </div>
  );
}

function EnvironmentStatusBadge({
  loading,
  runtime,
}: {
  loading: boolean;
  runtime: LocalSubtitleRuntimeSummary | null;
}) {
  const { t } = useTranslation(["subtitle"]);
  const ready = Boolean(
    runtime &&
    runtime.runner.status === "ready" &&
    runtime.mediaRuntime.status === "ready" &&
    runtime.backends.some(
      (backend) =>
        backend.backend === "cpu" && backend.status === "available",
    ),
  );
  return (
    <Badge variant={ready ? "secondary" : "outline"}>
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      {t(
        loading
          ? "subtitle:local_transcriber.environment.checking"
          : ready
            ? "subtitle:local_transcriber.environment.ready"
            : "subtitle:local_transcriber.environment.unavailable",
      )}
    </Badge>
  );
}

function BackendStatus({
  status,
}: {
  status: LocalSubtitleRuntimeSummary["backends"][number]["status"] | null;
}) {
  const { t } = useTranslation(["subtitle"]);
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 text-[11px] leading-5 ${
        status === "available"
          ? "text-emerald-700 dark:text-emerald-300"
          : status === "unverified"
            ? "text-amber-700 dark:text-amber-300"
            : "text-muted-foreground"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          status === "available"
            ? "bg-emerald-500"
            : status === "unverified"
              ? "bg-amber-500"
              : "bg-muted-foreground/50"
        }`}
      />
      {t(
        status
          ? `subtitle:local_transcriber.environment.backend_status.${status}`
          : "subtitle:local_transcriber.environment.backend_status.not_reported",
      )}
    </span>
  );
}

function ResourceStatusBadge({
  resource,
}: {
  resource: LocalSubtitleManagedResourceSummary;
}) {
  const { t } = useTranslation(["subtitle"]);
  return (
    <Badge
      variant="outline"
      className={
        resource.status === "ready"
          ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
          : resource.status === "invalid"
            ? "border-destructive/30 text-destructive"
            : "text-muted-foreground"
      }
    >
      {t(RESOURCE_STATUS_KEYS[resource.status])}
    </Badge>
  );
}
