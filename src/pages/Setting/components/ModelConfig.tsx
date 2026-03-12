import { useState, useCallback, useMemo, useEffect } from "react";
import useModelStore from "@/store/useModelStore";
import useAgentStore from "@/store/agent/useAgentStore";
import { Model } from "@/type/model";
import type { ModelProfile } from "@/type/model";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ButtonGroup } from "@/components/ui/button-group";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  OPENAI_MODEL_OPTIONS,
  DEFAULT_MODEL_URL_MAP,
  DEFAULT_MODEL_KEY_MAP,
  DEFAULT_TOKEN_PRICING_MAP,
} from "@/constants/model";
import {
  RefreshCw,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  KeyRound,
  Bot,
  Wrench,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_EXCLUDE_PATTERNS = [
  "embed", "whisper", "tts", "dall-e", "moderation",
  "audio", "realtime", "transcri", "search", "similarity",
  "code-", "text-", "if-", "canary",
];

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
  const { t } = useTranslation();

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
            <Label>{t("setting:fields.assignment.agent_model")}</Label>
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
          <Select
            value={assignment.agent ?? NONE_VALUE}
            onValueChange={(v) => setAssignment("agent", v === NONE_VALUE ? null : v)}
            disabled={hasActiveConversation}
          >
            <SelectTrigger className="w-full">
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
                  <span className="flex items-center gap-2">
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
            <Label>{t("setting:fields.assignment.task_model")}</Label>
          </div>
          <Select
            value={assignment.taskExecution ?? NONE_VALUE}
            onValueChange={(v) => setAssignment("taskExecution", v === NONE_VALUE ? null : v)}
          >
            <SelectTrigger className="w-full">
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
  const { profiles, removeProfile, assignment } = useModelStore();
  const [editingProfile, setEditingProfile] = useState<ModelProfile | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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
    assignment.agent === id || assignment.taskExecution === id;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-xl">
            {t("setting:subtitle.model_profiles")}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={handleAdd}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("setting:fields.profile.add")}
          </Button>
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
                    "flex items-center justify-between rounded-lg border px-4 py-3",
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
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-xs text-muted-foreground font-mono truncate">
                          {profile.modelKey}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {profile.apiKey
                            ? `API Key: ${profile.apiKey.slice(0, 4)}...${profile.apiKey.slice(-4)}`
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
                      onClick={() => handleEdit(profile)}
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

      <ProfileEditDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        profile={editingProfile}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Profile Edit Dialog
// ---------------------------------------------------------------------------

interface ProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: ModelProfile | null;
}

function ProfileEditDialog({ open, onOpenChange, profile }: ProfileDialogProps) {
  const { t } = useTranslation();
  const { addProfile, updateProfile } = useModelStore();
  const isNew = profile === null;

  const [name, setName] = useState("");
  const [provider, setProvider] = useState<Model>(Model.DeepSeek);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [inputPrice, setInputPrice] = useState<number>(0);
  const [outputPrice, setOutputPrice] = useState<number>(0);

  // OpenAI-specific
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [customModelInput, setCustomModelInput] = useState("");

  useEffect(() => {
    if (open) {
      if (profile) {
        setName(profile.name);
        setProvider(profile.provider);
        setApiKey(profile.apiKey);
        setBaseUrl(profile.baseUrl);
        setModelKey(profile.modelKey);
        setInputPrice(profile.tokenPricing.inputTokensPerMillion);
        setOutputPrice(profile.tokenPricing.outputTokensPerMillion);
      } else {
        setName("");
        setProvider(Model.DeepSeek);
        setApiKey("");
        setBaseUrl(DEFAULT_MODEL_URL_MAP[Model.DeepSeek]);
        setModelKey(DEFAULT_MODEL_KEY_MAP[Model.DeepSeek]);
        setInputPrice(DEFAULT_TOKEN_PRICING_MAP[Model.DeepSeek].inputTokensPerMillion);
        setOutputPrice(DEFAULT_TOKEN_PRICING_MAP[Model.DeepSeek].outputTokensPerMillion);
      }
      setFetchedModels([]);
      setCustomModelInput("");
    }
  }, [open, profile]);

  const handleProviderChange = (p: Model) => {
    setProvider(p);
    setBaseUrl(DEFAULT_MODEL_URL_MAP[p]);
    setModelKey(DEFAULT_MODEL_KEY_MAP[p]);
    setInputPrice(DEFAULT_TOKEN_PRICING_MAP[p].inputTokensPerMillion);
    setOutputPrice(DEFAULT_TOKEN_PRICING_MAP[p].outputTokensPerMillion);
    if (!name || name === Model.DeepSeek || name === Model.OpenAI || name === t("setting:fields.other")) {
      setName(p === Model.Other ? t("setting:fields.other") : p);
    }
    setFetchedModels([]);
    setCustomModelInput("");
  };

  const handleSave = () => {
    const trimmedName = name.trim() || provider;
    const data = {
      name: trimmedName,
      provider,
      apiKey,
      baseUrl,
      modelKey,
      tokenPricing: {
        inputTokensPerMillion: inputPrice,
        outputTokensPerMillion: outputPrice,
      },
    };

    if (isNew) {
      addProfile(data);
    } else {
      updateProfile(profile!.id, data);
    }
    onOpenChange(false);
  };

  // OpenAI model fetching
  const fetchOpenAIModels = useCallback(async () => {
    if (!apiKey) {
      toast.error(t("setting:fields.model_fetch.no_key"));
      return;
    }
    setIsFetchingModels(true);
    try {
      const modelsUrl = (baseUrl || DEFAULT_MODEL_URL_MAP[Model.OpenAI])
        .replace(/\/chat\/completions\/?$/, "/models");
      const response = await fetch(modelsUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const models: string[] = (data.data || [])
        .map((m: any) => m.id as string)
        .filter((id: string) => {
          const lower = id.toLowerCase();
          return !MODEL_EXCLUDE_PATTERNS.some((p) => lower.includes(p));
        })
        .sort();
      setFetchedModels(models);
      toast.success(t("setting:fields.model_fetch.success", { count: models.length }));
    } catch {
      toast.error(t("setting:fields.model_fetch.error"));
    } finally {
      setIsFetchingModels(false);
    }
  }, [apiKey, baseUrl, t]);

  const presetValues = useMemo(
    () => new Set(OPENAI_MODEL_OPTIONS.map((o) => o.value)),
    []
  );

  const remoteOnlyModels = useMemo(
    () => fetchedModels.filter((id) => !presetValues.has(id)),
    [fetchedModels, presetValues]
  );

  const allKnownValues = useMemo(
    () => new Set([...presetValues, ...fetchedModels]),
    [presetValues, fetchedModels]
  );
  const hasCustomKey = modelKey && !allKnownValues.has(modelKey);

  const handleOpenAiModelChange = (val: string) => {
    setModelKey(val);
    const matchedPreset = OPENAI_MODEL_OPTIONS.find((o) => o.value === val);
    if (matchedPreset) {
      setInputPrice(matchedPreset.pricing.inputTokensPerMillion);
      setOutputPrice(matchedPreset.pricing.outputTokensPerMillion);
    }
  };

  const handleApplyCustomModelKey = () => {
    const custom = customModelInput.trim();
    if (!custom) {
      toast.error(t("setting:fields.model_fetch.empty_custom_key"));
      return;
    }
    setModelKey(custom);
    setCustomModelInput("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNew
              ? t("setting:fields.profile.dialog_title_add")
              : t("setting:fields.profile.dialog_title_edit")}
          </DialogTitle>
          <DialogDescription>
            {t("setting:fields.profile.dialog_description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Profile Name */}
          <div className="space-y-2">
            <Label>{t("setting:fields.profile.name")}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("setting:fields.profile.name_placeholder")}
            />
          </div>

          {/* Provider */}
          <div className="space-y-2">
            <Label>{t("setting:fields.model_type")}</Label>
            <ButtonGroup>
              <Button
                size="sm"
                variant={provider === Model.DeepSeek ? "default" : "outline"}
                onClick={() => handleProviderChange(Model.DeepSeek)}
              >
                DeepSeek
              </Button>
              <Button
                size="sm"
                variant={provider === Model.OpenAI ? "default" : "outline"}
                onClick={() => handleProviderChange(Model.OpenAI)}
              >
                OpenAI
              </Button>
              <Button
                size="sm"
                variant={provider === Model.Other ? "default" : "outline"}
                onClick={() => handleProviderChange(Model.Other)}
              >
                {t("setting:fields.other")}
              </Button>
            </ButtonGroup>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label>{t("setting:fields.apikey")}</Label>
            <Input
              type="text"
              placeholder={t("setting:placeholder.apikey")}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          {/* OpenAI Model Selector */}
          {provider === Model.OpenAI && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>{t("setting:fields.model_name")}</Label>
                <div className="flex items-center gap-2">
                  <Select value={modelKey} onValueChange={handleOpenAiModelChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>{t("setting:fields.model_fetch.preset_group")}</SelectLabel>
                        {OPENAI_MODEL_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            <span className="flex items-center gap-2">
                              <span>{option.label}</span>
                              <span className="text-muted-foreground text-xs font-mono">{option.value}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                      {remoteOnlyModels.length > 0 && (
                        <>
                          <SelectSeparator />
                          <SelectGroup>
                            <SelectLabel>{t("setting:fields.model_fetch.remote_group")}</SelectLabel>
                            {remoteOnlyModels.map((id) => (
                              <SelectItem key={id} value={id}>
                                <span className="font-mono text-xs">{id}</span>
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </>
                      )}
                      {hasCustomKey && (
                        <>
                          <SelectSeparator />
                          <SelectItem value={modelKey}>
                            <span className="flex items-center gap-2">
                              <span>{modelKey}</span>
                              <span className="text-muted-foreground text-xs">({t("setting:fields.other")})</span>
                            </span>
                          </SelectItem>
                        </>
                      )}
                    </SelectContent>
                  </Select>
                  <Tooltip delayDuration={700}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="shrink-0 size-9"
                        onClick={fetchOpenAIModels}
                        disabled={isFetchingModels}
                      >
                        {isFetchingModels ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <RefreshCw className="size-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {t("setting:fields.model_fetch.refresh_tooltip")}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <Label>{t("setting:fields.model_fetch.manual_key_label")}</Label>
                  <span className="text-xs text-muted-foreground">
                    {t("setting:fields.model_fetch.manual_key_hint")}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder={t("setting:placeholder.model_key")}
                    value={customModelInput}
                    onChange={(e) => setCustomModelInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleApplyCustomModelKey();
                    }}
                  />
                  <Button variant="outline" onClick={handleApplyCustomModelKey}>
                    {t("setting:fields.model_fetch.apply_custom_key")}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Other: Base URL + Model Key */}
          {provider === Model.Other && (
            <>
              <div className="space-y-2">
                <Label>{t("setting:fields.model_url")}</Label>
                <Input
                  placeholder={t("setting:placeholder.model_url") + " (https://.../v1/chat/completions)"}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("setting:fields.model_key")}</Label>
                <Input
                  placeholder={t("setting:placeholder.model_key")}
                  value={modelKey}
                  onChange={(e) => setModelKey(e.target.value)}
                />
              </div>
            </>
          )}

          {/* Token Pricing */}
          <div className="space-y-3">
            <Label className="text-base">{t("setting:subtitle.token_price_config")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("setting:fields.token_price.intro_desc")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("setting:fields.token_price.input_price")}</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={inputPrice || ""}
                  onChange={(e) => setInputPrice(parseFloat(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("setting:fields.token_price.output_price")}</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={outputPrice || ""}
                  onChange={(e) => setOutputPrice(parseFloat(e.target.value) || 0)}
                />
              </div>
            </div>
            <div className="text-xs text-muted-foreground font-mono">
              {t("setting:fields.token_price.input_label")} ${inputPrice.toFixed(2)}/1M &nbsp;|&nbsp;
              {t("setting:fields.token_price.output_label")} ${outputPrice.toFixed(2)}/1M
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("setting:fields.profile.cancel")}
          </Button>
          <Button onClick={handleSave}>
            {isNew
              ? t("setting:fields.profile.create")
              : t("setting:fields.profile.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ModelConfig;
