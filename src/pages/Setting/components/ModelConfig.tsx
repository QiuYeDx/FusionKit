import { useState, useCallback, useEffect } from "react";
import useModelStore from "@/store/useModelStore";
import useAgentStore from "@/store/agent/useAgentStore";
import useOnboardingStore from "@/store/useOnboardingStore";
import useModelProfileDraftStore from "@/store/useModelProfileDraftStore";
import { Model } from "@/type/model";
import type { ModelProfile } from "@/type/model";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Pencil,
  Trash2,
  KeyRound,
  Bot,
  Wrench,
  AlertTriangle,
  Compass,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ModelProfileDialog } from "./ModelProfileDialog";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_COLORS: Record<Model, string> = {
  [Model.DeepSeek]: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/20",
  [Model.OpenAI]: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  [Model.Other]: "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/20",
};

const NONE_VALUE = "__none__";

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

function ModelConfig() {
  return (
    <div className="space-y-4">
      <ModelAssignmentCard />
      <ModelProfilesCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model Assignment Card
// ---------------------------------------------------------------------------

function ModelAssignmentCard() {
  const { t } = useTranslation();
  const { profiles, assignment, setAssignment } = useModelStore();
  const { isStreaming, session } = useAgentStore();
  const hasActiveConversation = isStreaming || session.messages.length > 0;

  const agentProfile = profiles.find((p) => p.id === assignment.agent);
  const taskProfile = profiles.find((p) => p.id === assignment.taskExecution);

  // The Agent works with both API formats (Chat Completions and Responses), so every profile can be chosen.
  const handleAgentAssignmentChange = useCallback(
    (value: string) => setAssignment("agent", value === NONE_VALUE ? null : value),
    [setAssignment],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">
          {t("setting:subtitle.model_assignment")}
        </CardTitle>
        <CardDescription>
          {t("setting:fields.assignment.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Agent Model Assignment */}
        <div className="space-y-2 max-w-2xl">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <Label id="model-assignment-agent">{t("setting:fields.assignment.agent_model")}</Label>
            {hasActiveConversation && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="text-xs gap-1 text-amber-600 dark:text-amber-400 border-amber-500/30">
                    <AlertTriangle className="h-3 w-3" />
                    {t("setting:fields.assignment.locked")}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  {t("setting:fields.assignment.locked_tooltip")}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <p className="text-xs text-muted-foreground" data-testid="model-assignment-agent-role">
            {t("setting:fields.assignment.agent_role")}
          </p>
          <Select
            value={assignment.agent ?? NONE_VALUE}
            onValueChange={handleAgentAssignmentChange}
            disabled={hasActiveConversation}
          >
            <SelectTrigger className="w-full" aria-labelledby="model-assignment-agent">
              <SelectValue placeholder={t("setting:fields.assignment.select_placeholder")}>
                {agentProfile ? (
                  <span className="flex items-center gap-2">
                    <span>{agentProfile.name}</span>
                    <span className="text-xs text-muted-foreground font-mono">{agentProfile.modelKey}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t("setting:fields.assignment.not_configured")}</span>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>
                <span className="text-muted-foreground">{t("setting:fields.assignment.not_configured")}</span>
              </SelectItem>
              {profiles.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="flex items-center gap-2 min-w-0">
                    <span>{p.name}</span>
                    <span className="text-xs text-muted-foreground font-mono">{p.modelKey}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Task Execution Model Assignment */}
        <div className="space-y-2 max-w-2xl">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            <Label id="model-assignment-task">{t("setting:fields.assignment.task_model")}</Label>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="model-assignment-task-role">
            {t("setting:fields.assignment.task_role")}
          </p>
          <Select
            value={assignment.taskExecution ?? NONE_VALUE}
            onValueChange={(v) => setAssignment("taskExecution", v === NONE_VALUE ? null : v)}
          >
            <SelectTrigger className="w-full" aria-labelledby="model-assignment-task">
              <SelectValue placeholder={t("setting:fields.assignment.select_placeholder")}>
                {taskProfile ? (
                  <span className="flex items-center gap-2">
                    <span>{taskProfile.name}</span>
                    <span className="text-xs text-muted-foreground font-mono">{taskProfile.modelKey}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t("setting:fields.assignment.not_configured")}</span>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>
                <span className="text-muted-foreground">{t("setting:fields.assignment.not_configured")}</span>
              </SelectItem>
              {profiles.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="flex items-center gap-2">
                    <span>{p.name}</span>
                    <span className="text-xs text-muted-foreground font-mono">{p.modelKey}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Model Profiles Card
// ---------------------------------------------------------------------------

function ModelProfilesCard() {
  const { t } = useTranslation();
  const {
    profiles,
    removeProfile,
    assignment,
  } = useModelStore();
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

  const handleAdd = () => {
    setEditingProfile(null);
    setIsDialogOpen(true);
  };

  const handleEdit = (profile: ModelProfile) => {
    setEditingProfile(profile);
    setIsDialogOpen(true);
  };

  const handleDelete = (id: string) => {
    if (confirmDeleteId === id) {
      removeProfile(id);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
      setTimeout(() => setConfirmDeleteId(null), 3000);
    }
  };

  const isInUse = (id: string) =>
    assignment.agent === id ||
    assignment.taskExecution === id;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-xl">
            {t("setting:subtitle.model_profiles")}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={openWizard}
              className="gap-1.5 text-muted-foreground"
              data-testid="reopen-onboarding"
            >
              <Compass className="h-3.5 w-3.5" />
              {t("setting:fields.onboarding.reopen")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleAdd}
              className="gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("setting:fields.profile.add")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {profiles.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <KeyRound className="h-8 w-8 mx-auto mb-3 opacity-40" />
              <p>{t("setting:fields.profile.empty")}</p>
              <Button
                variant="link"
                className="mt-2 text-sm"
                onClick={handleAdd}
              >
                {t("setting:fields.profile.add_first")}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {profiles.map((profile) => (
                <div
                  key={profile.id}
                  className={cn(
                    "flex items-center justify-between rounded-smooth-lg border px-4 py-3",
                    "bg-background hover:bg-accent/30 transition-colors"
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm truncate">
                          {profile.name}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn("text-[10px] px-1.5 py-0", PROVIDER_COLORS[profile.provider])}
                        >
                          {profile.provider === Model.Other
                            ? t("setting:fields.other")
                            : profile.provider}
                        </Badge>
                        {isInUse(profile.id) && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            {t("setting:fields.profile.in_use")}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          {profile.apiFormat === "responses"
                            ? t("setting:fields.api_format.responses")
                            : t("setting:fields.api_format.chat_completions")}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-xs text-muted-foreground font-mono truncate">
                          {profile.modelKey}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {profile.apiKey
                            ? t("setting:fields.profile.key_preview", { preview: `${profile.apiKey.slice(0, 4)}…${profile.apiKey.slice(-4)}` })
                            : t("setting:fields.profile.no_key")}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={t("setting:fields.profile.edit")}
                      onClick={() => handleEdit(profile)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("setting:fields.profile.delete")}
                      className={cn(
                        "h-8 w-8",
                        confirmDeleteId === profile.id
                          ? "text-destructive hover:text-destructive"
                          : "text-muted-foreground"
                      )}
                      onClick={() => handleDelete(profile.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ModelProfileDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        profile={editingProfile}
      />
    </>
  );
}

export default ModelConfig;
