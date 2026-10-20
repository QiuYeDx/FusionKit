import { useState, useCallback, useEffect } from "react";
import useModelStore from "@/store/useModelStore";
import useAgentStore from "@/store/agent/useAgentStore";
import useOnboardingStore from "@/store/useOnboardingStore";
import useModelProfileDraftStore from "@/store/useModelProfileDraftStore";
import { Model } from "@/type/model";
import type { ModelProfile } from "@/type/model";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Pencil, Trash2, KeyRound, Bot, Wrench, AlertTriangle, Compass } from "lucide-react";
import { cn } from "@/lib/utils";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { Panel, PanelRow, PageSection, ToneIcon, toneStyle, type Tone } from "@/pages/components/page-kit";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { ModelProfileDialog } from "./ModelProfileDialog";

const PROVIDER_COLORS: Record<Model, string> = {
  [Model.DeepSeek]: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/25",
  [Model.OpenAI]: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25",
  [Model.Other]: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/25",
};
const PROVIDER_TONES: Record<Model, Tone> = { [Model.DeepSeek]: "blue", [Model.OpenAI]: "green", [Model.Other]: "orange" };

const NONE_VALUE = "__none__";

function ModelConfig() {
  return <>
    <ModelAssignmentCard />
    <ModelProfilesCard />
  </>;
}

/** A model choice: the profile's name with its model in mono, or "not set". */
function ProfileSelect({ value, onChange, disabled, labelledBy }: { value: string | null; onChange: (value: string | null) => void; disabled?: boolean; labelledBy: string }) {
  const { t } = useTranslation();
  const profiles = useModelStore((state) => state.profiles);
  const selected = profiles.find((profile) => profile.id === value);
  const notSet = <span className="text-muted-foreground">{t("setting:fields.assignment.not_configured")}</span>;
  const option = (profile: ModelProfile) => <span className="flex min-w-0 items-center gap-2">
    <span className="truncate">{profile.name}</span>
    <span className="truncate font-mono text-xs text-muted-foreground">{profile.modelKey}</span>
  </span>;
  return <Select value={value ?? NONE_VALUE} onValueChange={(next) => onChange(next === NONE_VALUE ? null : next)} disabled={disabled}>
    <SelectTrigger className="h-9 w-full min-w-0 sm:w-72" aria-labelledby={labelledBy}>
      <SelectValue placeholder={t("setting:fields.assignment.select_placeholder")}>{selected ? option(selected) : notSet}</SelectValue>
    </SelectTrigger>
    <SelectContent>
      <SelectItem value={NONE_VALUE}>{notSet}</SelectItem>
      {profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{option(profile)}</SelectItem>)}
    </SelectContent>
  </Select>;
}

function ModelAssignmentCard() {
  const { t } = useTranslation();
  const { assignment, setAssignment } = useModelStore();
  const { isStreaming, session } = useAgentStore();
  const hasActiveConversation = isStreaming || session.messages.length > 0;
  // The Agent works with both API formats (Chat Completions and Responses), so every profile can be chosen.
  const setAgent = useCallback((value: string | null) => setAssignment("agent", value), [setAssignment]);

  return (
    <PageSection title={t("setting:subtitle.model_assignment")} description={t("setting:fields.assignment.description")}>
      <Panel>
        <PanelRow icon={Bot} tone="teal" labelId="model-assignment-agent"
          label={<span className="flex flex-wrap items-center gap-2">
            {t("setting:fields.assignment.agent_model")}
            {hasActiveConversation && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="gap-1 border-amber-500/30 text-[11px] font-normal text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" />{t("setting:fields.assignment.locked")}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{t("setting:fields.assignment.locked_tooltip")}</TooltipContent>
              </Tooltip>
            )}
          </span>}
          description={<span data-testid="model-assignment-agent-role">{t("setting:fields.assignment.agent_role")}</span>}
          control={<ProfileSelect value={assignment.agent} onChange={setAgent} disabled={hasActiveConversation} labelledBy="model-assignment-agent" />} />
        <PanelRow icon={Wrench} tone="orange" labelId="model-assignment-task" label={t("setting:fields.assignment.task_model")}
          description={<span data-testid="model-assignment-task-role">{t("setting:fields.assignment.task_role")}</span>}
          control={<ProfileSelect value={assignment.taskExecution} onChange={(value) => setAssignment("taskExecution", value)} labelledBy="model-assignment-task" />} />
      </Panel>
    </PageSection>
  );
}

function ModelProfilesCard() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotionPreference();
  const { profiles, removeProfile, assignment } = useModelStore();
  const [editingProfile, setEditingProfile] = useState<ModelProfile | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const openWizard = useOnboardingStore((state) => state.openWizard);
  const reopenRequested = useModelProfileDraftStore((state) => state.reopenRequested);

  // "Continue" on the notice after leaving the form for the network settings: the form comes back filled in.
  useEffect(() => {
    if (!reopenRequested) return;
    const drafts = useModelProfileDraftStore.getState();
    drafts.clearReopen();
    const draft = drafts.draft;
    if (!draft || draft.owner !== "settings") return;
    const editing = draft.profileId ? useModelStore.getState().getProfileById(draft.profileId) : null;
    if (draft.profileId && !editing) return;
    setEditingProfile(editing ?? null);
    setIsDialogOpen(true);
  }, [reopenRequested]);

  const handleAdd = () => { setEditingProfile(null); setIsDialogOpen(true); };
  const handleEdit = (profile: ModelProfile) => { setEditingProfile(profile); setIsDialogOpen(true); };
  // Deleting asks twice: the first click arms the button for three seconds.
  const handleDelete = (id: string) => {
    if (confirmDeleteId === id) {
      removeProfile(id);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
      setTimeout(() => setConfirmDeleteId(null), 3000);
    }
  };
  const roles = (id: string) => [
    assignment.agent === id && t("setting:fields.assignment.agent_model"),
    assignment.taskExecution === id && t("setting:fields.assignment.task_model"),
  ].filter(Boolean) as string[];

  return <>
    <PageSection title={t("setting:subtitle.model_profiles")} description={t("setting:groups.profiles_hint")}
      action={<>
        <Button variant="ghost" size="sm" onClick={openWizard} className="gap-1.5 text-muted-foreground" data-testid="reopen-onboarding">
          <Compass className="h-3.5 w-3.5" />{t("setting:fields.onboarding.reopen")}
        </Button>
        <Button variant="outline" size="sm" onClick={handleAdd} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />{t("setting:fields.profile.add")}
        </Button>
      </>}>
      <Panel>
        {profiles.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-10 text-center">
            <ToneIcon icon={KeyRound} tone="violet" size={44} />
            <p className="mt-3 text-sm text-muted-foreground">{t("setting:fields.profile.empty")}</p>
            <Button size="sm" className="mt-4 gap-1.5" onClick={handleAdd}><Plus className="h-3.5 w-3.5" />{t("setting:fields.profile.add_first")}</Button>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {profiles.map((profile) => {
              const used = roles(profile.id);
              return <motion.div key={profile.id} layout={!reduceMotion} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                transition={reduceMotion ? { duration: 0 } : { type: "spring", duration: 0.32, bounce: 0 }} className="kit-row !p-0 overflow-hidden" data-testid="model-profile-row">
                <div className="flex w-full items-center gap-3 px-4 py-3.5">
                  <ProfileInitial name={profile.name} tone={PROVIDER_TONES[profile.provider]} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-medium">{profile.name}</span>
                      <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px] font-normal", PROVIDER_COLORS[profile.provider])}>
                        {profile.provider === Model.Other ? t("setting:fields.other") : profile.provider}
                      </Badge>
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground">
                        {profile.apiFormat === "responses" ? t("setting:fields.api_format.responses") : t("setting:fields.api_format.chat_completions")}
                      </Badge>
                      {used.length > 0 && <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal" title={used.join(" · ")}>
                        {t("setting:fields.profile.in_use")} · {used.join(" · ")}
                      </Badge>}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate font-mono">{profile.modelKey}</span>
                      <span aria-hidden className="text-muted-foreground/40">·</span>
                      <span className="shrink-0">
                        {profile.apiKey
                          ? t("setting:fields.profile.key_preview", { preview: `${profile.apiKey.slice(0, 4)}…${profile.apiKey.slice(-4)}` })
                          : t("setting:fields.profile.no_key")}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" aria-label={t("setting:fields.profile.edit")} onClick={() => handleEdit(profile)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Tooltip open={confirmDeleteId === profile.id || undefined}>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={t("setting:fields.profile.delete")} onClick={() => handleDelete(profile.id)}
                          className={cn("h-8 w-8", confirmDeleteId === profile.id ? "bg-destructive/10 text-destructive hover:text-destructive" : "text-muted-foreground hover:text-foreground")}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={6}>{confirmDeleteId === profile.id ? t("setting:fields.profile.delete_again") : t("setting:fields.profile.delete")}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </motion.div>;
            })}
          </AnimatePresence>
        )}
      </Panel>
    </PageSection>

    <ModelProfileDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} profile={editingProfile} />
  </>;
}

/** The profile's initial on its provider's tone, so the list reads at a glance. */
function ProfileInitial({ name, tone }: { name: string; tone: Tone }) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return <SmoothCorners radius={11} smoothing={0.72} className="kit-tone-icon size-9 shrink-0 text-[14px] font-semibold" style={toneStyle(tone)} aria-hidden>
    {initial}
  </SmoothCorners>;
}

export default ModelConfig;
