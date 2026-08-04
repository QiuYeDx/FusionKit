import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Cpu,
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
  readonly error: LocalSubtitleDisplayError | null;
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
  error,
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
        badge={<EnvironmentStatusBadge loading={loading} runtime={runtime} />}
        actions={
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
        }
      >
        <RuntimeSummary
          runtime={runtime}
          loading={loading}
          backendPreviewStatus={backendPreviewStatus}
          backendPreview={backendPreview}
        />
      </ToolPanel>

      <ToolPanel
        icon={HardDrive}
        title={t("subtitle:local_transcriber.resources.title")}
        badge={
          <Badge variant="outline">
            {t("subtitle:local_transcriber.resources.ready_count", {
              ready: readyCount,
              total: resources.length,
            })}
          </Badge>
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
          </>
        }
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5 text-[11px] text-muted-foreground">
          <span>{t("subtitle:local_transcriber.resources.managed_only")}</span>
          <span className="font-mono tabular-nums">
            {t("subtitle:local_transcriber.resources.disk_usage", {
              size: formatLocalSubtitleBytes(installedBytes),
            })}
          </span>
        </div>

        {error ? (
          <div className="p-4 pb-0">
            <LocalSubtitleErrorNotice error={error} />
          </div>
        ) : null}

        <div className="divide-y">
          {resources.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
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
  const values = [
    {
      label: t("subtitle:local_transcriber.environment.platform"),
      value: runtime ? `${runtime.platform} · ${runtime.arch}` : "-",
    },
    {
      label: t("subtitle:local_transcriber.environment.contract"),
      value: runtime
        ? `HTTP v${LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION}`
        : "-",
    },
    {
      label: t("subtitle:local_transcriber.environment.runner"),
      value:
        runtime?.runner.version ??
        runtime?.runner.errorCode ??
        t("subtitle:local_transcriber.environment.not_ready"),
    },
    {
      label: t("subtitle:local_transcriber.environment.ffmpeg"),
      value:
        runtime?.mediaRuntime.version ??
        runtime?.mediaRuntime.errorCode ??
        t("subtitle:local_transcriber.environment.not_ready"),
    },
  ];

  return (
    <div data-testid="local-subtitle-runtime-summary">
      <div className="grid grid-cols-2 lg:grid-cols-4">
        {values.map((item) => (
          <div key={item.label} className="min-w-0 border-b border-r px-4 py-3">
            <div className="text-[10.5px] uppercase tracking-[0.05em] text-muted-foreground">
              {item.label}
            </div>
            <div className="mt-1 min-w-0 break-words font-mono text-xs font-semibold [overflow-wrap:anywhere]">
              {loading ? <span className="animate-pulse">...</span> : item.value}
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-2 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-medium">
            <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
            {t("subtitle:local_transcriber.environment.backends")}
          </div>
          <div className="min-w-0 break-words text-right text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            {backendPreviewStatus === "ready" && backendPreview
              ? t("subtitle:local_transcriber.environment.execution_profile", {
                  preference: backendPreview.devicePreference.toUpperCase(),
                  backend: backendPreview.resolvedBackend.toUpperCase(),
                  version: backendPreview.serverVersion,
                })
              : backendPreviewStatus === "loading"
                ? t("subtitle:local_transcriber.environment.resolving_backend")
                : t("subtitle:local_transcriber.environment.unavailable_short")}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {runtime ? (
            BACKENDS.map((backendId) => {
              const backend = runtime.backends.find(
                (entry) => entry.backend === backendId,
              );
              return (
                <div
                  key={backendId}
                  className="min-w-0 border-l-2 pl-2.5 text-xs"
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="font-medium">
                      {t(BACKEND_KEYS[backendId])}
                    </span>
                    <BackendBadge status={backend?.status ?? null} />
                  </div>
                  {backend?.errorCode ? (
                    <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[10.5px] text-muted-foreground [overflow-wrap:anywhere]">
                      {backend.errorCode}
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="text-xs text-muted-foreground">
              {t("subtitle:local_transcriber.environment.no_backend_data")}
            </div>
          )}
        </div>
      </div>
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
        <div className="mt-2 whitespace-pre-wrap break-words border-l-2 border-amber-500/70 bg-amber-500/5 px-2.5 py-2 font-mono text-[10.5px] text-muted-foreground [overflow-wrap:anywhere]">
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

function BackendBadge({
  status,
}: {
  status: LocalSubtitleRuntimeSummary["backends"][number]["status"] | null;
}) {
  const { t } = useTranslation(["subtitle"]);
  return (
    <Badge
      variant="outline"
      className={
        status === "available"
          ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
          : status === "unverified"
            ? "border-amber-500/30 text-amber-700 dark:text-amber-300"
            : "text-muted-foreground"
      }
    >
      {t(
        status
          ? `subtitle:local_transcriber.environment.backend_status.${status}`
          : "subtitle:local_transcriber.environment.backend_status.not_reported",
      )}
    </Badge>
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
