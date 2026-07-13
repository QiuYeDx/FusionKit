import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Captions,
  CheckCircle2,
  Link2,
  Mic2,
  Pencil,
  Plus,
  Radio,
  Trash2,
  Volume2,
  Waves,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  ScrollableDialogHeader,
  DialogDescription,
  DialogTitle,
} from "@/components/qiuye-ui/scrollable-dialog";
import { canAssignAudioProfileToTask } from "@/lib/audio-profile";
import { MIMO_TTS_MODEL_BY_MODE } from "@/lib/audio-provider-registry";
import { cn } from "@/lib/utils";
import useModelStore from "@/store/useModelStore";
import {
  AUDIO_ASSIGNMENT_KEYS,
  getAudioModelKeyForAssignment,
  getDefaultAudioCapabilities,
  resolveAudioTranscriptionModelMatrix,
  type AudioApiDialect,
  type AudioAssignmentKey,
  type AudioCapability,
  type AudioModelProfile,
  type AudioSpeechResponseFormat,
  type AudioTranscriptionResponseFormat,
  type MimoSpeechSynthesisMode,
} from "@/type/audio";
import type { Model } from "@/type/model";

const NONE_VALUE = "__none__";

const AUDIO_DIALECTS: AudioApiDialect[] = [
  "openai_audio",
  "mimo_chat_audio",
  "openai_realtime",
];

const TRANSCRIPTION_FORMATS: AudioTranscriptionResponseFormat[] = [
  "json",
  "text",
  "srt",
  "verbose_json",
  "vtt",
];

const SPEECH_FORMATS: AudioSpeechResponseFormat[] = [
  "mp3",
  "opus",
  "aac",
  "flac",
  "wav",
  "pcm",
  "pcm16",
];

const MIMO_TTS_MODES: MimoSpeechSynthesisMode[] = [
  "preset_voice",
  "voice_design",
  "voice_clone",
];

const AUDIO_ASSIGNMENT_ICONS: Record<AudioAssignmentKey, typeof Mic2> = {
  transcription: Mic2,
  speechSynthesis: Volume2,
  realtimeCaptions: Captions,
  realtimeVoice: Radio,
};

const DIALECT_BADGE_CLASS: Record<AudioApiDialect, string> = {
  openai_audio: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  mimo_chat_audio: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  openai_realtime: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
};

export default function AudioModelConfig() {
  return (
    <div className="space-y-4">
      <AudioAssignmentCard />
      <AudioProfilesCard />
    </div>
  );
}

function AudioAssignmentCard() {
  const { t } = useTranslation();
  const {
    audioProfiles,
    audioAssignment,
    setAudioAssignment,
  } = useModelStore();

  const handleAssignmentChange = (
    assignmentKey: AudioAssignmentKey,
    value: string,
  ) => {
    if (value === NONE_VALUE) {
      setAudioAssignment(assignmentKey, null);
      return;
    }

    const profile = audioProfiles.find((item) => item.id === value);
    if (!canAssignAudioProfileToTask(profile, assignmentKey)) {
      toast.error(t("setting:fields.audio.assignment.unsupported_select"));
      return;
    }
    setAudioAssignment(assignmentKey, value);
  };

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
        {AUDIO_ASSIGNMENT_KEYS.map((assignmentKey) => {
          const selectedProfile = audioProfiles.find(
            (profile) => profile.id === audioAssignment[assignmentKey],
          );
          const Icon = AUDIO_ASSIGNMENT_ICONS[assignmentKey];

          return (
            <div key={assignmentKey} className="space-y-2">
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-muted-foreground" />
                <Label>{t(`setting:fields.audio.assignment.${assignmentKey}`)}</Label>
              </div>
              <Select
                value={audioAssignment[assignmentKey] ?? NONE_VALUE}
                onValueChange={(value) =>
                  handleAssignmentChange(assignmentKey, value)
                }
              >
                <SelectTrigger>
                  <SelectValue>
                    {selectedProfile ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{selectedProfile.name}</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {getProfileModelKey(selectedProfile, assignmentKey)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("setting:fields.assignment.not_configured")}
                      </span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_VALUE}>
                    <span className="text-muted-foreground">
                      {t("setting:fields.assignment.not_configured")}
                    </span>
                  </SelectItem>
                  {audioProfiles.map((profile) => {
                    const supported = canAssignAudioProfileToTask(
                      profile,
                      assignmentKey,
                    );
                    return (
                      <SelectItem
                        key={profile.id}
                        value={profile.id}
                        disabled={!supported}
                      >
                        <span className="flex items-center gap-2">
                          <span>{profile.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {getProfileModelKey(profile, assignmentKey) ??
                              t("setting:fields.audio.profile.model_missing")}
                          </span>
                          {!supported && (
                            <Badge variant="outline" className="text-[10px]">
                              {t("setting:fields.audio.assignment.unsupported")}
                            </Badge>
                          )}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function AudioProfilesCard() {
  const { t } = useTranslation();
  const {
    profiles,
    audioProfiles,
    audioAssignment,
    removeAudioProfile,
  } = useModelStore();
  const [editingProfile, setEditingProfile] =
    useState<AudioModelProfile | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const openCreateDialog = () => {
    setEditingProfile(null);
    setIsDialogOpen(true);
  };

  const openEditDialog = (profile: AudioModelProfile) => {
    setEditingProfile(profile);
    setIsDialogOpen(true);
  };

  const handleDelete = (id: string) => {
    if (confirmDeleteId === id) {
      removeAudioProfile(id);
      setConfirmDeleteId(null);
      return;
    }

    setConfirmDeleteId(id);
    setTimeout(() => setConfirmDeleteId(null), 3000);
  };

  const isInUse = (id: string) =>
    Object.values(audioAssignment).some((assignedId) => assignedId === id);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle className="text-xl">
              {t("setting:subtitle.audio_profiles")}
            </CardTitle>
            <CardDescription>
              {t("setting:fields.audio.profile.description")}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={openCreateDialog}
            className="gap-1.5"
            disabled={profiles.length === 0}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("setting:fields.audio.profile.add")}
          </Button>
        </CardHeader>
        <CardContent>
          {profiles.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              <Link2 className="mx-auto mb-3 h-8 w-8 opacity-40" />
              {t("setting:fields.audio.profile.no_connection_profiles")}
            </div>
          ) : audioProfiles.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              <Waves className="mx-auto mb-3 h-8 w-8 opacity-40" />
              <p>{t("setting:fields.audio.profile.empty")}</p>
              <Button variant="link" className="mt-2" onClick={openCreateDialog}>
                {t("setting:fields.audio.profile.add_first")}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {audioProfiles.map((profile) => {
                const connectionProfile = profiles.find(
                  (item) => item.id === profile.connectionProfileId,
                );

                return (
                  <div
                    key={profile.id}
                    className={cn(
                      "flex items-center justify-between rounded-lg border px-4 py-3",
                      "bg-background transition-colors hover:bg-accent/30",
                    )}
                  >
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {profile.name}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn("text-[10px] px-1.5 py-0", DIALECT_BADGE_CLASS[profile.audioDialect])}
                        >
                          {t(`setting:fields.audio.dialect.${profile.audioDialect}`)}
                        </Badge>
                        {isInUse(profile.id) && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            {t("setting:fields.profile.in_use")}
                          </Badge>
                        )}
                        {connectionProfile ? (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {connectionProfile.name}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-destructive">
                            {t("setting:fields.audio.profile.connection_missing")}
                          </Badge>
                        )}
                      </div>
                      <div className="grid gap-1 text-xs text-muted-foreground md:grid-cols-4">
                        <ModelLine
                          label={t("setting:fields.audio.model.transcription")}
                          value={profile.models.transcription}
                        />
                        <ModelLine
                          label={t("setting:fields.audio.model.speechSynthesis")}
                          value={profile.models.speechSynthesis}
                        />
                        <ModelLine
                          label={t("setting:fields.audio.model.realtimeTranscription")}
                          value={profile.models.realtimeTranscription ?? profile.models.realtime}
                        />
                        <ModelLine
                          label={t("setting:fields.audio.model.realtimeVoice")}
                          value={profile.models.realtimeVoice ?? profile.models.realtime}
                        />
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {resolveProfileCapabilities(profile).map((capability) => (
                          <Badge
                            key={capability}
                            variant="outline"
                            className="px-1.5 py-0 text-[10px] text-muted-foreground"
                          >
                            {t(`setting:fields.audio.capability.${capability}`)}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="ml-3 flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEditDialog(profile)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "h-8 w-8",
                          confirmDeleteId === profile.id
                            ? "text-destructive hover:text-destructive"
                            : "text-muted-foreground",
                        )}
                        onClick={() => handleDelete(profile.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <AudioProfileDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        profile={editingProfile}
      />
    </>
  );
}

interface AudioProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: AudioModelProfile | null;
}

function AudioProfileDialog({
  open,
  onOpenChange,
  profile,
}: AudioProfileDialogProps) {
  const { t } = useTranslation();
  const {
    profiles,
    addAudioProfile,
    updateAudioProfile,
  } = useModelStore();
  const isNew = profile === null;

  const [name, setName] = useState("");
  const [connectionProfileId, setConnectionProfileId] = useState("");
  const [audioDialect, setAudioDialect] =
    useState<AudioApiDialect>("openai_audio");
  const [transcriptionModel, setTranscriptionModel] = useState("");
  const [speechSynthesisModel, setSpeechSynthesisModel] = useState("");
  const [realtimeModel, setRealtimeModel] = useState("");
  const [realtimeTranscriptionModel, setRealtimeTranscriptionModel] = useState("");
  const [language, setLanguage] = useState("auto");
  const [transcriptionResponseFormat, setTranscriptionResponseFormat] =
    useState<AudioTranscriptionResponseFormat>("json");
  const [ttsVoice, setTtsVoice] = useState("");
  const [ttsResponseFormat, setTtsResponseFormat] =
    useState<AudioSpeechResponseFormat>("wav");
  const [realtimeVoice, setRealtimeVoice] = useState("");
  const [mimoTtsMode, setMimoTtsMode] =
    useState<MimoSpeechSynthesisMode>("preset_voice");
  const [streamSpeechByDefault, setStreamSpeechByDefault] = useState(true);

  useEffect(() => {
    if (!open) return;

    if (profile) {
      setName(profile.name);
      setConnectionProfileId(profile.connectionProfileId);
      setAudioDialect(profile.audioDialect);
      setTranscriptionModel(profile.models.transcription ?? "");
      setSpeechSynthesisModel(profile.models.speechSynthesis ?? "");
      setRealtimeModel(profile.models.realtimeVoice ?? profile.models.realtime ?? "");
      setRealtimeTranscriptionModel(
        profile.models.realtimeTranscription ?? profile.models.realtime ?? "",
      );
      setLanguage(profile.defaults.language ?? "auto");
      setTranscriptionResponseFormat(
        profile.defaults.transcriptionResponseFormat ?? "json",
      );
      setTtsVoice(profile.defaults.ttsVoice ?? "");
      setTtsResponseFormat(profile.defaults.ttsResponseFormat ?? "wav");
      setRealtimeVoice(profile.defaults.realtimeVoice ?? "");
      setMimoTtsMode(profile.defaults.mimoTtsMode ?? "preset_voice");
      setStreamSpeechByDefault(
        profile.defaults.streamSpeechByDefault ?? true,
      );
      return;
    }

    const defaultDialect: AudioApiDialect = "openai_audio";
    setName(t("setting:fields.audio.profile.default_name.openai_audio"));
    setConnectionProfileId(profiles[0]?.id ?? "");
    setAudioDialect(defaultDialect);
    applyDialectDefaults(defaultDialect);
  }, [open, profile, profiles, t]);

  const visibleCapabilities = useMemo(
    () => getDefaultAudioCapabilities(audioDialect),
    [audioDialect],
  );
  const connectionProvider = useMemo(
    () => profiles.find((item) => item.id === connectionProfileId)?.provider,
    [connectionProfileId, profiles],
  );
  const transcriptionMatrix = useMemo(
    () =>
      resolveAudioTranscriptionModelMatrix({
        audioDialect,
        provider: connectionProvider,
        modelKey: transcriptionModel,
      }),
    [audioDialect, connectionProvider, transcriptionModel],
  );

  useEffect(() => {
    if (
      open &&
      audioDialect !== "openai_realtime" &&
      !transcriptionMatrix.responseFormats.includes(transcriptionResponseFormat)
    ) {
      setTranscriptionResponseFormat(transcriptionMatrix.responseFormats[0]);
    }
  }, [
    audioDialect,
    open,
    transcriptionMatrix,
    transcriptionResponseFormat,
  ]);

  const handleDialectChange = (value: string) => {
    const nextDialect = value as AudioApiDialect;
    setAudioDialect(nextDialect);
    setName((currentName) =>
      currentName.trim()
        ? currentName
        : t(`setting:fields.audio.profile.default_name.${nextDialect}`),
    );
    applyDialectDefaults(nextDialect);
  };

  const handleMimoModeChange = (value: string) => {
    const nextMode = value as MimoSpeechSynthesisMode;
    setMimoTtsMode(nextMode);
    setSpeechSynthesisModel(MIMO_TTS_MODEL_BY_MODE[nextMode]);
  };

  const applyDialectDefaults = (dialect: AudioApiDialect) => {
    if (dialect === "openai_audio") {
      setTranscriptionModel("gpt-4o-transcribe");
      setSpeechSynthesisModel("gpt-4o-mini-tts");
      setRealtimeModel("");
      setRealtimeTranscriptionModel("");
      setLanguage("auto");
      setTranscriptionResponseFormat("json");
      setTtsVoice("alloy");
      setTtsResponseFormat("wav");
      setRealtimeVoice("");
      setMimoTtsMode("preset_voice");
      setStreamSpeechByDefault(false);
      return;
    }

    if (dialect === "mimo_chat_audio") {
      setTranscriptionModel("mimo-v2.5-asr");
      setSpeechSynthesisModel(MIMO_TTS_MODEL_BY_MODE.preset_voice);
      setRealtimeModel("mimo-v2.5-asr");
      setRealtimeTranscriptionModel("");
      setLanguage("auto");
      setTranscriptionResponseFormat("json");
      setTtsVoice("mimo_default");
      setTtsResponseFormat("pcm16");
      setRealtimeVoice("");
      setMimoTtsMode("preset_voice");
      setStreamSpeechByDefault(true);
      return;
    }

    setTranscriptionModel("");
    setSpeechSynthesisModel("");
    setRealtimeModel("gpt-realtime");
    setRealtimeTranscriptionModel("gpt-realtime-whisper");
    setLanguage("auto");
    setTranscriptionResponseFormat("json");
    setTtsVoice("");
    setTtsResponseFormat("pcm16");
    setRealtimeVoice("marin");
    setMimoTtsMode("preset_voice");
    setStreamSpeechByDefault(false);
  };

  const handleSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t("setting:fields.audio.profile.name_required"));
      return;
    }
    if (!connectionProfileId) {
      toast.error(t("setting:fields.audio.profile.connection_required"));
      return;
    }
    if (!connectionProvider) {
      toast.error(t("setting:fields.audio.profile.connection_required"));
      return;
    }

    const data = createAudioProfileInput({
      name: trimmedName,
      connectionProfileId,
      provider: connectionProvider,
      audioDialect,
      transcriptionModel,
      speechSynthesisModel,
      realtimeModel,
      realtimeTranscriptionModel,
      language,
      transcriptionResponseFormat,
      ttsVoice,
      ttsResponseFormat,
      realtimeVoice,
      mimoTtsMode,
      streamSpeechByDefault,
    });

    if (isNew) {
      addAudioProfile(data);
    } else {
      updateAudioProfile(profile.id, data);
    }
    onOpenChange(false);
  };

  return (
    <ScrollableDialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidth="sm:max-w-[720px]"
    >
      <ScrollableDialogHeader>
        <DialogTitle>
          {isNew
            ? t("setting:fields.audio.profile.dialog_title_add")
            : t("setting:fields.audio.profile.dialog_title_edit")}
        </DialogTitle>
        <DialogDescription>
          {t("setting:fields.audio.profile.dialog_description")}
        </DialogDescription>
      </ScrollableDialogHeader>

      <ScrollableDialogContent fadeMasks>
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("setting:fields.audio.profile.name")}</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("setting:fields.audio.profile.name_placeholder")}
              />
            </div>

            <div className="space-y-2">
              <Label>{t("setting:fields.audio.profile.connection_profile")}</Label>
              <Select
                value={connectionProfileId}
                onValueChange={setConnectionProfileId}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("setting:fields.audio.profile.connection_placeholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((connectionProfile) => (
                    <SelectItem
                      key={connectionProfile.id}
                      value={connectionProfile.id}
                    >
                      <span className="flex items-center gap-2">
                        <span>{connectionProfile.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {connectionProfile.baseUrl || connectionProfile.provider}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("setting:fields.audio.profile.dialect")}</Label>
            <Select value={audioDialect} onValueChange={handleDialectChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUDIO_DIALECTS.map((dialect) => (
                  <SelectItem key={dialect} value={dialect}>
                    <span className="flex items-center gap-2">
                      <span>{t(`setting:fields.audio.dialect.${dialect}`)}</span>
                      <span className="text-xs text-muted-foreground">
                        {t(`setting:fields.audio.dialect_hint.${dialect}`)}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              {t("setting:fields.audio.profile.capabilities")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {visibleCapabilities.map((capability) => (
                <Badge key={capability} variant="outline" className="text-[10px]">
                  {t(`setting:fields.audio.capability.${capability}`)}
                </Badge>
              ))}
            </div>
          </div>

          {audioDialect !== "openai_realtime" && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("setting:fields.audio.model.transcription")}</Label>
                <Input
                  value={transcriptionModel}
                  onChange={(event) => setTranscriptionModel(event.target.value)}
                  placeholder={audioDialect === "mimo_chat_audio"
                    ? "mimo-v2.5-asr"
                    : "gpt-4o-transcribe"}
                />
              </div>

              <div className="space-y-2">
                <Label>{t("setting:fields.audio.defaults.language")}</Label>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      {t("setting:fields.audio.language.auto")}
                    </SelectItem>
                    <SelectItem value="zh">
                      {t("setting:fields.audio.language.zh")}
                    </SelectItem>
                    <SelectItem value="en">
                      {t("setting:fields.audio.language.en")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {audioDialect === "openai_audio" && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("setting:fields.audio.model.speechSynthesis")}</Label>
                <Input
                  value={speechSynthesisModel}
                  onChange={(event) => setSpeechSynthesisModel(event.target.value)}
                  placeholder="gpt-4o-mini-tts"
                />
              </div>
              <div className="space-y-2">
                <Label>{t("setting:fields.audio.defaults.ttsVoice")}</Label>
                <Input
                  value={ttsVoice}
                  onChange={(event) => setTtsVoice(event.target.value)}
                  placeholder="alloy"
                />
              </div>
            </div>
          )}

          {audioDialect === "mimo_chat_audio" && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("setting:fields.audio.defaults.mimoTtsMode")}</Label>
                <Select value={mimoTtsMode} onValueChange={handleMimoModeChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MIMO_TTS_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        <span className="flex items-center gap-2">
                          <span>{t(`setting:fields.audio.mimo_mode.${mode}`)}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {MIMO_TTS_MODEL_BY_MODE[mode]}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("setting:fields.audio.model.speechSynthesis")}</Label>
                <Input
                  value={speechSynthesisModel}
                  onChange={(event) => setSpeechSynthesisModel(event.target.value)}
                  placeholder={MIMO_TTS_MODEL_BY_MODE[mimoTtsMode]}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("setting:fields.audio.defaults.ttsVoice")}</Label>
                <Input
                  value={ttsVoice}
                  onChange={(event) => setTtsVoice(event.target.value)}
                  placeholder="mimo_default"
                />
              </div>
            </div>
          )}

          {audioDialect === "openai_realtime" && (
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>{t("setting:fields.audio.model.realtimeTranscription")}</Label>
                <Input
                  value={realtimeTranscriptionModel}
                  onChange={(event) => setRealtimeTranscriptionModel(event.target.value)}
                  placeholder="gpt-realtime-whisper"
                />
              </div>
              <div className="space-y-2">
                <Label>{t("setting:fields.audio.model.realtimeVoice")}</Label>
                <Input
                  value={realtimeModel}
                  onChange={(event) => setRealtimeModel(event.target.value)}
                  placeholder="gpt-realtime"
                />
              </div>
              <div className="space-y-2">
                <Label>{t("setting:fields.audio.defaults.realtimeVoice")}</Label>
                <Input
                  value={realtimeVoice}
                  onChange={(event) => setRealtimeVoice(event.target.value)}
                  placeholder="marin"
                />
              </div>
            </div>
          )}

          {audioDialect !== "openai_realtime" && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>
                  {t("setting:fields.audio.defaults.transcriptionResponseFormat")}
                </Label>
                <Select
                  value={transcriptionResponseFormat}
                  onValueChange={(value) =>
                    setTranscriptionResponseFormat(
                      value as AudioTranscriptionResponseFormat,
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSCRIPTION_FORMATS.map((format) => (
                      <SelectItem
                        key={format}
                        value={format}
                        disabled={
                          !transcriptionMatrix.responseFormats.includes(format)
                        }
                      >
                        {format}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>{t("setting:fields.audio.defaults.ttsResponseFormat")}</Label>
                <Select
                  value={ttsResponseFormat}
                  onValueChange={(value) =>
                    setTtsResponseFormat(value as AudioSpeechResponseFormat)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SPEECH_FORMATS.map((format) => (
                      <SelectItem
                        key={format}
                        value={format}
                        disabled={
                          audioDialect === "mimo_chat_audio" &&
                          format !== "wav" &&
                          format !== "pcm16"
                        }
                      >
                        {format}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {audioDialect !== "openai_realtime" && (
            <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
              <div>
                <Label>{t("setting:fields.audio.defaults.streamSpeechByDefault")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("setting:fields.audio.defaults.streamSpeechByDefault_hint")}
                </p>
              </div>
              <Switch
                checked={streamSpeechByDefault}
                onCheckedChange={setStreamSpeechByDefault}
              />
            </div>
          )}

          {audioDialect !== "mimo_chat_audio" && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("setting:fields.audio.profile.mimo_only_hint")}</span>
            </div>
          )}
        </div>
      </ScrollableDialogContent>

      <ScrollableDialogFooter className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t("setting:fields.profile.cancel")}
        </Button>
        <Button onClick={handleSave}>
          {isNew
            ? t("setting:fields.profile.create")
            : t("setting:fields.profile.save")}
        </Button>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  );
}

function createAudioProfileInput(args: {
  name: string;
  connectionProfileId: string;
  provider: Model;
  audioDialect: AudioApiDialect;
  transcriptionModel: string;
  speechSynthesisModel: string;
  realtimeModel: string;
  realtimeTranscriptionModel: string;
  language: string;
  transcriptionResponseFormat: AudioTranscriptionResponseFormat;
  ttsVoice: string;
  ttsResponseFormat: AudioSpeechResponseFormat;
  realtimeVoice: string;
  mimoTtsMode: MimoSpeechSynthesisMode;
  streamSpeechByDefault: boolean;
}) {
  const models: Partial<AudioModelProfile["models"]> = {};
  if (args.audioDialect !== "openai_realtime") {
    models.transcription = normalizeOptional(args.transcriptionModel);
  }
  if (args.audioDialect === "openai_audio" || args.audioDialect === "mimo_chat_audio") {
    models.speechSynthesis = normalizeOptional(args.speechSynthesisModel);
  }
  if (args.audioDialect === "openai_realtime") {
    models.realtimeTranscription = normalizeOptional(
      args.realtimeTranscriptionModel,
    );
    models.realtimeVoice = normalizeOptional(args.realtimeModel);
  }

  const transcriptionMatrix = resolveAudioTranscriptionModelMatrix({
    audioDialect: args.audioDialect,
    provider: args.provider,
    modelKey: models.transcription,
  });

  return {
    name: args.name,
    connectionProfileId: args.connectionProfileId,
    audioDialect: args.audioDialect,
    models,
    defaults: {
      language: args.language,
      transcriptionResponseFormat: transcriptionMatrix.responseFormats.includes(
        args.transcriptionResponseFormat,
      )
        ? args.transcriptionResponseFormat
        : transcriptionMatrix.responseFormats[0],
      ttsVoice: normalizeOptional(args.ttsVoice),
      ttsResponseFormat:
        args.audioDialect === "mimo_chat_audio" &&
        args.ttsResponseFormat !== "wav" &&
        args.ttsResponseFormat !== "pcm16"
          ? "pcm16"
          : args.ttsResponseFormat,
      realtimeVoice: normalizeOptional(args.realtimeVoice),
      mimoTtsMode:
        args.audioDialect === "mimo_chat_audio"
          ? args.mimoTtsMode
          : undefined,
      streamSpeechByDefault: args.streamSpeechByDefault,
    },
  };
}

function ModelLine({
  label,
  value,
}: {
  label: string;
  value: string | undefined;
}) {
  return (
    <div className="min-w-0">
      <span>{label}: </span>
      <span className="font-mono">
        {value || "-"}
      </span>
    </div>
  );
}

function getProfileModelKey(
  profile: AudioModelProfile,
  assignmentKey: AudioAssignmentKey,
): string | undefined {
  return getAudioModelKeyForAssignment(profile, assignmentKey);
}

function resolveProfileCapabilities(profile: AudioModelProfile): AudioCapability[] {
  return profile.capabilities.length > 0
    ? profile.capabilities
    : getDefaultAudioCapabilities(profile.audioDialect);
}

function normalizeOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}
