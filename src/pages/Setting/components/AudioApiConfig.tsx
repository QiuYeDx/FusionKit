import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Captions,
  CheckCircle2,
  CircleAlert,
  KeyRound,
  Mic2,
  Network,
  Pencil,
  Plus,
  Radio,
  RotateCcw,
  Trash2,
  Volume2,
  Waves,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  DialogDescription,
  DialogTitle,
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  ScrollableDialogHeader,
} from "@/components/qiuye-ui/scrollable-dialog";
import {
  canAudioApiHandleTask,
  getAvailableSpeechSynthesisModes,
} from "@/lib/audio-provider-registry";
import { cn } from "@/lib/utils";
import useAudioApiStore, {
  type AudioApiProfileDraft,
  type AudioProfileAssignmentReplacements,
} from "@/store/useAudioApiStore";
import useProxyStore from "@/store/useProxyStore";
import {
  AUDIO_ASSIGNMENT_KEYS,
  AUDIO_PROVIDER_PRESETS,
  type AudioApiProfile,
  type AudioAssignmentKey,
  type AudioProviderPreset,
} from "@/type/audio";
import type { AudioToolReturnPath } from "../settingNavigation";
import {
  CUSTOM_AUDIO_ROUTE_DEFINITIONS,
  applyAudioProviderPreset,
  createAudioApiFormState,
  getConfiguredAudioTasks,
  getCustomAudioRoute,
  setCustomAudioRoute,
  validateAudioApiForm,
  type AudioApiFormErrorCode,
  type AudioApiFormState,
  type CustomAudioRouteKey,
} from "./audioApiConfigModel";

const NONE_VALUE = "__none__";
const PENDING_VALUE = "__pending__";

const ASSIGNMENT_ICONS: Record<AudioAssignmentKey, typeof Mic2> = {
  transcription: Mic2,
  speechSynthesis: Volume2,
  realtimeCaptions: Captions,
  realtimeVoice: Radio,
};

const PROVIDER_BADGE_CLASS: Record<AudioProviderPreset, string> = {
  openai:
    "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  mimo:
    "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  custom_openai_compatible:
    "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

interface AudioApiConfigProps {
  returnTo: AudioToolReturnPath | null;
  onReturn?: () => void;
  onNavigateProxy: () => void;
}

interface AssignmentNotice {
  profileId: string;
  assignmentKeys: AudioAssignmentKey[];
}

export default function AudioApiConfig({
  returnTo,
  onReturn,
  onNavigateProxy,
}: AudioApiConfigProps) {
  const { t } = useTranslation();
  const {
    profiles,
    assignment,
    addProfile,
    updateProfileWithResult,
    setAssignment,
    undoAutoAssignments,
    removeProfileWithAssignments,
    getAssignmentKeysForProfile,
  } = useAudioApiStore();
  const [editingProfile, setEditingProfile] =
    useState<AudioApiProfile | null>(null);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [deletingProfile, setDeletingProfile] =
    useState<AudioApiProfile | null>(null);
  const [autoAssignmentNotice, setAutoAssignmentNotice] =
    useState<AssignmentNotice | null>(null);
  const [clearedAssignments, setClearedAssignments] =
    useState<AudioAssignmentKey[]>([]);

  const openCreateDialog = useCallback(() => {
    setEditingProfile(null);
    setProfileDialogOpen(true);
  }, []);

  const openEditDialog = useCallback((profile: AudioApiProfile) => {
    setEditingProfile(profile);
    setProfileDialogOpen(true);
  }, []);

  const handleAssignmentChange = useCallback((
    key: AudioAssignmentKey,
    value: string,
  ) => {
    const updated = setAssignment(key, value === NONE_VALUE ? null : value);
    if (!updated) {
      toast.error(t("setting:fields.audio.assignment.unsupported_select"));
    }
  }, [setAssignment, t]);

  const handleUndoAutoAssignments = useCallback((notice: AssignmentNotice) => {
    const cleared = undoAutoAssignments(
      notice.profileId,
      notice.assignmentKeys,
    );
    setAutoAssignmentNotice(null);
    toast.success(t("setting:fields.audio.feedback.undo_success", {
      count: cleared.length,
    }));
  }, [t, undoAutoAssignments]);

  const showAutoAssignmentToast = useCallback((notice: AssignmentNotice) => {
    toast.success(t("setting:fields.audio.feedback.auto_assigned_title"), {
      description: t("setting:fields.audio.feedback.auto_assigned_description", {
        tasks: formatTaskList(notice.assignmentKeys, t),
      }),
      action: {
        label: t("setting:fields.audio.feedback.undo"),
        onClick: () => handleUndoAutoAssignments(notice),
      },
    });
  }, [handleUndoAutoAssignments, t]);

  const handleProfileSave = useCallback((args: {
    profile: AudioApiProfile | null;
    draft: AudioApiProfileDraft;
    returnAfterSave: boolean;
  }) => {
    if (args.profile) {
      const result = updateProfileWithResult(args.profile.id, args.draft);
      if (!result.updated) {
        toast.error(t("setting:fields.audio.feedback.save_failed"));
        return;
      }
      setClearedAssignments(result.clearedAssignmentKeys);
      if (args.returnAfterSave && result.clearedAssignmentKeys.length > 0) {
        toast.warning(
          t("setting:fields.audio.feedback.assignments_cleared"),
          {
            description: formatTaskList(result.clearedAssignmentKeys, t),
          },
        );
      } else {
        toast.success(t("setting:fields.audio.feedback.updated"));
      }
    } else {
      const result = addProfile(args.draft);
      const notice = result.autoAssignedTasks.length > 0
        ? {
            profileId: result.profileId,
            assignmentKeys: result.autoAssignedTasks,
          }
        : null;
      setAutoAssignmentNotice(notice);
      setClearedAssignments([]);
      toast.success(t("setting:fields.audio.feedback.created"));
      if (notice && args.returnAfterSave) showAutoAssignmentToast(notice);
    }
    setProfileDialogOpen(false);
    if (args.returnAfterSave) onReturn?.();
  }, [addProfile, onReturn, showAutoAssignmentToast, t, updateProfileWithResult]);

  const handleDelete = useCallback((
    profile: AudioApiProfile,
    replacements: AudioProfileAssignmentReplacements,
  ) => {
    const result = removeProfileWithAssignments(profile.id, replacements);
    if (!result.removed) return result;

    if (autoAssignmentNotice?.profileId === profile.id) {
      setAutoAssignmentNotice(null);
    }
    setDeletingProfile(null);
    toast.success(t("setting:fields.audio.feedback.deleted"));
    return result;
  }, [autoAssignmentNotice?.profileId, removeProfileWithAssignments, t]);

  return (
    <div
      className="space-y-4"
      data-testid="audio-api-settings"
    >
      {returnTo && onReturn && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onReturn}
            data-testid="audio-settings-return"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("setting:fields.audio.feedback.return_to_tool")}
          </Button>
        </div>
      )}

      {autoAssignmentNotice && (
        <Alert
          className="border-emerald-500/25 bg-emerald-500/5"
          data-testid="audio-auto-assignment"
        >
          <CheckCircle2 className="text-emerald-600 dark:text-emerald-400" />
          <AlertTitle>
            {t("setting:fields.audio.feedback.auto_assigned_title")}
          </AlertTitle>
          <AlertDescription>
            <p>
              {t("setting:fields.audio.feedback.auto_assigned_description", {
                tasks: formatTaskList(autoAssignmentNotice.assignmentKeys, t),
              })}
            </p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => handleUndoAutoAssignments(autoAssignmentNotice)}
              data-testid="audio-auto-assignment-undo"
            >
              <RotateCcw />
              {t("setting:fields.audio.feedback.undo")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {clearedAssignments.length > 0 && (
        <Alert className="border-amber-500/25 bg-amber-500/5">
          <CircleAlert className="text-amber-600 dark:text-amber-400" />
          <AlertTitle>
            {t("setting:fields.audio.feedback.assignments_cleared")}
          </AlertTitle>
          <AlertDescription>
            {formatTaskList(clearedAssignments, t)}
          </AlertDescription>
        </Alert>
      )}

      <AudioAssignmentCard
        profiles={profiles}
        assignment={assignment}
        onChange={handleAssignmentChange}
      />

      <AudioApiProfilesCard
        profiles={profiles}
        assignment={assignment}
        onAdd={openCreateDialog}
        onEdit={openEditDialog}
        onDelete={setDeletingProfile}
      />

      <AudioApiProfileDialog
        open={profileDialogOpen}
        onOpenChange={setProfileDialogOpen}
        profile={editingProfile}
        returnTo={returnTo}
        onSave={handleProfileSave}
        onNavigateProxy={onNavigateProxy}
      />

      <DeleteAudioApiDialog
        open={Boolean(deletingProfile)}
        onOpenChange={(open) => {
          if (!open) setDeletingProfile(null);
        }}
        profile={deletingProfile}
        profiles={profiles}
        affectedAssignmentKeys={deletingProfile
          ? getAssignmentKeysForProfile(deletingProfile.id)
          : []}
        onDelete={handleDelete}
      />
    </div>
  );
}

function AudioAssignmentCard({
  profiles,
  assignment,
  onChange,
}: {
  profiles: AudioApiProfile[];
  assignment: Record<AudioAssignmentKey, string | null>;
  onChange: (key: AudioAssignmentKey, value: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">
          {t("setting:subtitle.audio_assignment")}
        </CardTitle>
        <CardDescription>
          {t("setting:fields.audio.assignment.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        {AUDIO_ASSIGNMENT_KEYS.map((key) => {
          const Icon = ASSIGNMENT_ICONS[key];
          const compatibleProfiles = profiles.filter((profile) =>
            canAudioApiHandleTask(profile, key),
          );
          const selected = profiles.find(
            (profile) => profile.id === assignment[key],
          );
          return (
            <div key={key} className="min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-muted-foreground" />
                <Label htmlFor={`audio-assignment-${key}`}>
                  {t(`setting:fields.audio.assignment.${key}`)}
                </Label>
              </div>
              <Select
                value={assignment[key] ?? NONE_VALUE}
                onValueChange={(value) => onChange(key, value)}
              >
                <SelectTrigger
                  id={`audio-assignment-${key}`}
                  className="w-full"
                  aria-label={t(`setting:fields.audio.assignment.${key}`)}
                  data-testid={`audio-assignment-${key}`}
                >
                  <SelectValue>
                    {selected ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{selected.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {t(`setting:fields.audio.provider.${selected.providerPreset}`)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("setting:fields.audio.assignment.not_configured")}
                      </span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_VALUE}>
                    {t("setting:fields.audio.assignment.not_configured")}
                  </SelectItem>
                  {compatibleProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      <span className="flex items-center gap-2">
                        <span>{profile.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {t(`setting:fields.audio.provider.${profile.providerPreset}`)}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {compatibleProfiles.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("setting:fields.audio.assignment.no_compatible_api")}
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function AudioApiProfilesCard({
  profiles,
  assignment,
  onAdd,
  onEdit,
  onDelete,
}: {
  profiles: AudioApiProfile[];
  assignment: Record<AudioAssignmentKey, string | null>;
  onAdd: () => void;
  onEdit: (profile: AudioApiProfile) => void;
  onDelete: (profile: AudioApiProfile) => void;
}) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-xl">
            {t("setting:subtitle.audio_apis")}
          </CardTitle>
          <CardDescription>
            {t("setting:fields.audio.api.description")}
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAdd}
          data-testid="audio-api-add"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("setting:fields.audio.api.add")}
        </Button>
      </CardHeader>
      <CardContent>
        {profiles.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <KeyRound className="mx-auto mb-3 h-8 w-8 opacity-40" />
            <p className="font-medium text-foreground">
              {t("setting:fields.audio.api.empty")}
            </p>
            <p className="mt-1">
              {t("setting:fields.audio.api.empty_description")}
            </p>
            <Button type="button" variant="link" className="mt-2" onClick={onAdd}>
              {t("setting:fields.audio.api.add_first")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {profiles.map((profile) => {
              const assignedKeys = AUDIO_ASSIGNMENT_KEYS.filter(
                (key) => assignment[key] === profile.id,
              );
              const configuredTasks = getConfiguredAudioTasks(profile);
              return (
                <div
                  key={profile.id}
                  className="flex items-start justify-between gap-3 rounded-lg border bg-background px-4 py-3 transition-colors hover:bg-accent/30"
                  data-testid="audio-api-profile"
                >
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {profile.name}
                      </span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "px-1.5 py-0 text-[10px]",
                          PROVIDER_BADGE_CLASS[profile.providerPreset],
                        )}
                      >
                        {t(`setting:fields.audio.provider.${profile.providerPreset}`)}
                      </Badge>
                      {assignedKeys.length > 0 && (
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                          {t("setting:fields.audio.api.in_use")}
                        </Badge>
                      )}
                      {profile.migration?.needsAttention && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/25 px-1.5 py-0 text-[10px] text-amber-700 dark:text-amber-300"
                        >
                          {t("setting:fields.audio.api.migration_needs_attention")}
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {profile.baseUrl || t("setting:fields.audio.api.base_url_missing")}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {configuredTasks.map((key) => (
                        <Badge
                          key={key}
                          variant="outline"
                          className="px-1.5 py-0 text-[10px] text-muted-foreground"
                        >
                          {t(`setting:fields.audio.assignment.${key}`)}
                        </Badge>
                      ))}
                      {configuredTasks.length === 0 && (
                        <span className="text-xs text-destructive">
                          {t("setting:fields.audio.api.no_routes")}
                        </span>
                      )}
                    </div>
                    {assignedKeys.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {t("setting:fields.audio.api.assigned_to", {
                          tasks: formatTaskList(assignedKeys, t),
                        })}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => onEdit(profile)}
                          aria-label={t("setting:fields.audio.api.edit")}
                          data-testid="audio-api-edit"
                        >
                          <Pencil />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("setting:fields.audio.api.edit")}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => onDelete(profile)}
                          aria-label={t("setting:fields.audio.api.delete")}
                          data-testid="audio-api-delete"
                        >
                          <Trash2 />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("setting:fields.audio.api.delete")}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AudioApiProfileDialog({
  open,
  onOpenChange,
  profile,
  returnTo,
  onSave,
  onNavigateProxy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: AudioApiProfile | null;
  returnTo: AudioToolReturnPath | null;
  onSave: (args: {
    profile: AudioApiProfile | null;
    draft: AudioApiProfileDraft;
    returnAfterSave: boolean;
  }) => void;
  onNavigateProxy: () => void;
}) {
  const { t } = useTranslation();
  const { proxyConfig } = useProxyStore();
  const [form, setForm] = useState<AudioApiFormState>(() =>
    createDialogForm(profile, t),
  );
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [confirmProxyNavigation, setConfirmProxyNavigation] = useState(false);
  const validation = useMemo(() => validateAudioApiForm(form), [form]);
  const configuredTasks = useMemo(
    () => getConfiguredAudioTasks(form.routes),
    [form.routes],
  );

  useEffect(() => {
    if (!open) return;
    setForm(createDialogForm(profile, t));
    setValidationAttempted(false);
    setConfirmProxyNavigation(false);
  }, [open, profile, t]);

  const handleProviderChange = (providerPreset: AudioProviderPreset) => {
    setForm((current) => {
      const translatedDefaults = AUDIO_PROVIDER_PRESETS.map((preset) =>
        t(`setting:fields.audio.api.default_name.${preset}`),
      );
      const shouldReplaceName = !current.name.trim() ||
        translatedDefaults.includes(current.name);
      const next = applyAudioProviderPreset(current, providerPreset);
      return {
        ...next,
        name: shouldReplaceName
          ? t(`setting:fields.audio.api.default_name.${providerPreset}`)
          : current.name,
      };
    });
  };

  const submit = (returnAfterSave: boolean) => {
    setValidationAttempted(true);
    if (!validation.draft) return;
    onSave({ profile, draft: validation.draft, returnAfterSave });
  };

  return (
    <>
      <ScrollableDialog
        open={open}
        onOpenChange={onOpenChange}
        maxWidth="sm:max-w-2xl"
      >
        <ScrollableDialogHeader>
          <DialogTitle>
            {profile
              ? t("setting:fields.audio.api.dialog_title_edit")
              : t("setting:fields.audio.api.dialog_title_add")}
          </DialogTitle>
          <DialogDescription>
            {t("setting:fields.audio.api.dialog_description")}
          </DialogDescription>
        </ScrollableDialogHeader>

        <ScrollableDialogContent fadeMasks>
          <div className="space-y-6" data-testid="audio-api-dialog">
            <FormSection
              title={t("setting:fields.audio.api.service_section")}
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {AUDIO_PROVIDER_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    type="button"
                    variant={form.providerPreset === preset ? "default" : "outline"}
                    className="h-auto min-h-16 whitespace-normal px-3 py-2 text-left"
                    onClick={() => handleProviderChange(preset)}
                    aria-pressed={form.providerPreset === preset}
                    data-testid={`audio-provider-${preset}`}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {t(`setting:fields.audio.provider.${preset}`)}
                      </span>
                      <span className="mt-0.5 block text-xs font-normal opacity-75">
                        {t(`setting:fields.audio.provider.${preset}_hint`)}
                      </span>
                    </span>
                  </Button>
                ))}
              </div>
            </FormSection>

            <FormSection
              title={t("setting:fields.audio.api.connection_section")}
            >
              <FormField
                label={t("setting:fields.audio.api.name")}
                error={validationAttempted
                  ? errorText(validation.fieldErrors.name, t)
                  : undefined}
                htmlFor="audio-api-name"
              >
                <Input
                  id="audio-api-name"
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder={t("setting:fields.audio.api.name_placeholder")}
                  aria-invalid={validationAttempted && Boolean(validation.fieldErrors.name)}
                  data-testid="audio-api-name"
                />
              </FormField>

              <FormField
                label={t("setting:fields.audio.api.base_url")}
                error={validationAttempted
                  ? errorText(validation.fieldErrors.baseUrl, t)
                  : undefined}
                htmlFor="audio-api-base-url"
              >
                <Input
                  id="audio-api-base-url"
                  value={form.baseUrl}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder={t("setting:fields.audio.api.base_url_placeholder")}
                  aria-invalid={validationAttempted && Boolean(validation.fieldErrors.baseUrl)}
                  data-testid="audio-api-base-url"
                />
              </FormField>

              <FormField
                label={t("setting:fields.audio.api.api_key")}
                error={validationAttempted
                  ? errorText(validation.fieldErrors.apiKey, t)
                  : undefined}
                htmlFor="audio-api-key"
              >
                <Input
                  id="audio-api-key"
                  type="password"
                  autoComplete="off"
                  value={form.apiKey}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, apiKey: event.target.value }))}
                  placeholder={t("setting:fields.audio.api.api_key_placeholder")}
                  aria-invalid={validationAttempted && Boolean(validation.fieldErrors.apiKey)}
                  data-testid="audio-api-key"
                />
              </FormField>

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Network className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {t("setting:fields.audio.api.proxy_summary")}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {t(`setting:fields.proxy.${proxyConfig.mode}`)}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmProxyNavigation(true)}
                >
                  {t("setting:fields.audio.api.open_proxy_settings")}
                </Button>
              </div>
            </FormSection>

            <FormSection
              title={t("setting:fields.audio.api.capabilities_section")}
              description={form.providerPreset === "custom_openai_compatible"
                ? t("setting:fields.audio.api.advanced_routes_hint")
                : undefined}
            >
              {form.providerPreset === "custom_openai_compatible" ? (
                <CustomAudioRoutesEditor
                  form={form}
                  onChange={setForm}
                  routeErrors={validationAttempted ? validation.routeErrors : {}}
                />
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {configuredTasks.map((key) => (
                      <Badge key={key} variant="outline">
                        {t(`setting:fields.audio.assignment.${key}`)}
                      </Badge>
                    ))}
                  </div>
                  {form.providerPreset === "mimo" && (
                    <p className="text-xs text-muted-foreground">
                      {t("setting:fields.audio.api.mimo_modes_ready", {
                        count: getAvailableSpeechSynthesisModes(form.routes).length,
                      })}
                    </p>
                  )}
                </div>
              )}
              {validationAttempted && validation.fieldErrors.routes && (
                <p className="text-xs text-destructive" role="alert">
                  {errorText(validation.fieldErrors.routes, t)}
                </p>
              )}
            </FormSection>
          </div>
        </ScrollableDialogContent>

        <ScrollableDialogFooter className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("setting:fields.profile.cancel")}
          </Button>
          {returnTo && (
            <Button
              type="button"
              variant="outline"
              onClick={() => submit(false)}
              data-testid="audio-api-save"
            >
              {t("setting:fields.profile.save")}
            </Button>
          )}
          <Button
            type="button"
            onClick={() => submit(Boolean(returnTo))}
            data-testid={returnTo ? "audio-api-save-return" : "audio-api-save"}
          >
            {returnTo
              ? t("setting:fields.audio.feedback.save_and_return")
              : profile
                ? t("setting:fields.profile.save")
                : t("setting:fields.profile.create")}
          </Button>
        </ScrollableDialogFooter>
      </ScrollableDialog>

      <ConfirmDialog
        open={confirmProxyNavigation}
        onOpenChange={setConfirmProxyNavigation}
        title={t("setting:fields.audio.api.leave_dialog_title")}
        description={t("setting:fields.audio.api.leave_dialog_description")}
        cancelText={t("setting:fields.profile.cancel")}
        confirmText={t("setting:fields.audio.api.open_proxy_settings")}
        variant="default"
        onConfirm={() => {
          onOpenChange(false);
          onNavigateProxy();
        }}
      />
    </>
  );
}

function CustomAudioRoutesEditor({
  form,
  onChange,
  routeErrors,
}: {
  form: AudioApiFormState;
  onChange: (state: AudioApiFormState) => void;
  routeErrors: Partial<Record<CustomAudioRouteKey, AudioApiFormErrorCode>>;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {CUSTOM_AUDIO_ROUTE_DEFINITIONS.map((definition) => {
        const route = getCustomAudioRoute(form.routes, definition.key);
        const enabled = Boolean(route?.enabled);
        const error = errorText(routeErrors[definition.key], t);
        return (
          <div key={definition.key} className="rounded-lg border px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor={`audio-route-${definition.key}`}>
                  {t(`setting:fields.audio.route.${routeTranslationKey(definition.key)}`)}
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {definition.transport}
                </p>
              </div>
              <Switch
                id={`audio-route-${definition.key}`}
                checked={enabled}
                onCheckedChange={(checked) =>
                  onChange(setCustomAudioRoute(
                    form,
                    definition.key,
                    checked,
                    route?.model ?? "",
                  ))}
              />
            </div>
            {enabled && (
              <div className="mt-3 space-y-1.5">
                <Label htmlFor={`audio-route-model-${definition.key}`}>
                  {t("setting:fields.audio.route.model")}
                </Label>
                <Input
                  id={`audio-route-model-${definition.key}`}
                  value={route?.model ?? ""}
                  onChange={(event) =>
                    onChange(setCustomAudioRoute(
                      form,
                      definition.key,
                      true,
                      event.target.value,
                    ))}
                  aria-invalid={Boolean(error)}
                />
                {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DeleteAudioApiDialog({
  open,
  onOpenChange,
  profile,
  profiles,
  affectedAssignmentKeys,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: AudioApiProfile | null;
  profiles: AudioApiProfile[];
  affectedAssignmentKeys: AudioAssignmentKey[];
  onDelete: (
    profile: AudioApiProfile,
    replacements: AudioProfileAssignmentReplacements,
  ) => ReturnType<ReturnType<typeof useAudioApiStore.getState>["removeProfileWithAssignments"]>;
}) {
  const { t } = useTranslation();
  const [replacements, setReplacements] =
    useState<AudioProfileAssignmentReplacements>({});
  const [invalidKeys, setInvalidKeys] = useState<AudioAssignmentKey[]>([]);

  useEffect(() => {
    if (!open) return;
    setReplacements({});
    setInvalidKeys([]);
  }, [open, profile?.id]);

  if (!profile) return null;
  const allSelected = affectedAssignmentKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(replacements, key),
  );

  const submit = () => {
    const result = onDelete(profile, replacements);
    if (!result || result.removed) return;
    setInvalidKeys(result.invalidReplacementKeys);
    toast.error(t("setting:fields.audio.delete.failed"));
  };

  return (
    <ScrollableDialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidth="sm:max-w-lg"
    >
      <ScrollableDialogHeader>
        <DialogTitle>{t("setting:fields.audio.delete.title")}</DialogTitle>
        <DialogDescription>
          {affectedAssignmentKeys.length > 0
            ? t("setting:fields.audio.delete.in_use_description", {
                name: profile.name,
              })
            : t("setting:fields.audio.delete.unused_description", {
                name: profile.name,
              })}
        </DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent fadeMasks={affectedAssignmentKeys.length > 0}>
        {affectedAssignmentKeys.length > 0 && (
          <div className="space-y-4" data-testid="audio-api-delete-dialog">
            {affectedAssignmentKeys.map((key) => {
              const compatible = profiles.filter(
                (candidate) => candidate.id !== profile.id &&
                  canAudioApiHandleTask(candidate, key),
              );
              const selected = Object.prototype.hasOwnProperty.call(replacements, key)
                ? replacements[key] ?? NONE_VALUE
                : PENDING_VALUE;
              return (
                <div key={key} className="space-y-2">
                  <Label>{t(`setting:fields.audio.assignment.${key}`)}</Label>
                  <Select
                    value={selected}
                    onValueChange={(value) => {
                      setInvalidKeys((current) => current.filter((item) => item !== key));
                      setReplacements((current) => ({
                        ...current,
                        [key]: value === NONE_VALUE ? null : value,
                      }));
                    }}
                  >
                    <SelectTrigger aria-invalid={invalidKeys.includes(key)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={PENDING_VALUE} disabled>
                        {t("setting:fields.audio.delete.select_replacement")}
                      </SelectItem>
                      <SelectItem value={NONE_VALUE}>
                        {t("setting:fields.audio.delete.unassign")}
                      </SelectItem>
                      {compatible.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {invalidKeys.includes(key) && (
                    <p className="text-xs text-destructive" role="alert">
                      {t("setting:fields.audio.delete.required")}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {t("setting:fields.profile.cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={!allSelected}
          onClick={submit}
        >
          <Trash2 />
          {t("setting:fields.audio.delete.confirm")}
        </Button>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  );
}

function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <Separator />
      {children}
    </section>
  );
}

function FormField({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}

function createDialogForm(
  profile: AudioApiProfile | null,
  t: (key: string) => string,
): AudioApiFormState {
  const form = createAudioApiFormState(profile);
  if (!profile) {
    form.name = t(`setting:fields.audio.api.default_name.${form.providerPreset}`);
  }
  return form;
}

function routeTranslationKey(key: CustomAudioRouteKey): string {
  return key === "speechSynthesis.preset_voice" ? "preset_voice" : key;
}

function errorText(
  code: AudioApiFormErrorCode | undefined,
  t: (key: string) => string,
): string | undefined {
  return code ? t(`setting:fields.audio.api.errors.${code}`) : undefined;
}

function formatTaskList(
  keys: readonly AudioAssignmentKey[],
  t: (key: string) => string,
): string {
  return keys
    .map((key) => t(`setting:fields.audio.assignment.${key}`))
    .join(t("setting:fields.audio.feedback.task_separator"));
}
