import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import useModelStore from "@/store/useModelStore";
import useModelProfileDraftStore, {
  type ModelProfileDraftOwner,
  type ModelProfileFormValues,
} from "@/store/useModelProfileDraftStore";
import { Model } from "@/type/model";
import type {
  ModelApiFormat,
  ModelProfile,
  OutputTokenParameter,
} from "@/type/model";
import { SegmentedControl } from "@/components/qiuye-ui/segmented-control";
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
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  DialogDescription,
  DialogTitle,
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  ScrollableDialogHeader,
} from "@/components/qiuye-ui/scrollable-dialog";
import { DialogTransition } from "@/components/qiuye-ui/dialog-motion";
import { ApiKeyInput } from "@/components/model-setup/ApiKeyInput";
import {
  ConnectionTestStatus,
  type ConnectionTestState,
} from "@/components/model-setup/ConnectionTestStatus";
import {
  OPENAI_MODEL_OPTIONS,
  DEEPSEEK_MODEL_OPTIONS,
  DEFAULT_MODEL_BASE_URL_MAP,
  DEFAULT_MODEL_API_FORMAT_MAP,
  DEFAULT_MODEL_KEY_MAP,
  DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP,
  DEFAULT_TOKEN_PRICING_MAP,
  DEEPSEEK_API_KEYS_URL,
  DEEPSEEK_TOP_UP_URL,
} from "@/constants/model";
import { normalizeModelEndpoint } from "@/lib/model-endpoint";
import { classifyModelError, modelErrorGuide, openExternalPage } from "@/services/ai-error-guide";
import { settingPath } from "@/pages/Setting/settingNavigation";
import { profileDiffersFromPreset } from "./modelProfilePreset";
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  ExternalLink,
  PlugZap,
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

const ADVANCED_SECTION = "advanced";

// ---------------------------------------------------------------------------
// Profile Edit Dialog
// ---------------------------------------------------------------------------

export interface ModelProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The profile to edit, or null to add one. */
  profile: ModelProfile | null;
  /** Called after a save with the profile's id. */
  onSaved?: (id: string, created: boolean) => void;
  /** Whose form this is; a form left through a next-step button comes back to the same owner. */
  draftOwner?: ModelProfileDraftOwner;
  /** Runs when a next-step button leads elsewhere, after the form was kept and closed. */
  onLeave?: () => void;
}

/** How long the "continue" notice stays after leaving the form for the network settings. */
const DRAFT_NOTICE_MS = 30_000;

export function ModelProfileDialog({ open, onOpenChange, profile, onSaved, draftOwner = "settings", onLeave }: ModelProfileDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { addProfile, updateProfile } = useModelStore();
  const isNew = profile === null;

  const [name, setName] = useState("");
  const [provider, setProvider] = useState<Model>(Model.DeepSeek);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [apiFormat, setApiFormat] =
    useState<ModelApiFormat>("chat_completions");
  const [outputTokenParameter, setOutputTokenParameter] =
    useState<OutputTokenParameter>("max_tokens");
  const [inputPrice, setInputPrice] = useState<number>(0);
  const [outputPrice, setOutputPrice] = useState<number>(0);
  const [advanced, setAdvanced] = useState("");
  const [test, setTest] = useState<ConnectionTestState>({ status: "idle" });
  const testRun = useRef(0);

  // OpenAI-specific
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [customModelInput, setCustomModelInput] = useState("");

  const applyValues = (values: ModelProfileFormValues) => {
    setName(values.name);
    setProvider(values.provider);
    setApiKey(values.apiKey);
    setBaseUrl(values.baseUrl);
    setModelKey(values.modelKey);
    setApiFormat(values.apiFormat);
    setOutputTokenParameter(values.outputTokenParameter);
    setInputPrice(values.inputPrice);
    setOutputPrice(values.outputPrice);
  };

  useEffect(() => {
    if (open) {
      // Back from a next-step button: what was typed before leaving.
      const kept = useModelProfileDraftStore.getState().take(draftOwner, profile?.id ?? null);
      if (kept) {
        applyValues(kept);
        setAdvanced(profileDiffersFromPreset({
          provider: kept.provider,
          apiFormat: kept.apiFormat,
          outputTokenParameter: kept.outputTokenParameter,
          modelKey: kept.modelKey,
          tokenPricing: { inputTokensPerMillion: kept.inputPrice, outputTokensPerMillion: kept.outputPrice },
        }) ? ADVANCED_SECTION : "");
      } else if (profile) {
        setName(profile.name);
        setProvider(profile.provider);
        setApiKey(profile.apiKey);
        setBaseUrl(profile.baseUrl);
        setModelKey(profile.modelKey);
        setApiFormat(profile.apiFormat);
        setOutputTokenParameter(
          profile.outputTokenParameter ??
            DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP[profile.provider],
        );
        setInputPrice(profile.tokenPricing.inputTokensPerMillion);
        setOutputPrice(profile.tokenPricing.outputTokensPerMillion);
        // Settings that differ from the preset stay in view.
        setAdvanced(profileDiffersFromPreset(profile) ? ADVANCED_SECTION : "");
      } else {
        setName("");
        setProvider(Model.DeepSeek);
        setApiKey("");
        setBaseUrl(DEFAULT_MODEL_BASE_URL_MAP[Model.DeepSeek]);
        setModelKey(DEFAULT_MODEL_KEY_MAP[Model.DeepSeek]);
        setApiFormat(DEFAULT_MODEL_API_FORMAT_MAP[Model.DeepSeek]);
        setOutputTokenParameter(DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP[Model.DeepSeek]);
        setInputPrice(DEFAULT_TOKEN_PRICING_MAP[Model.DeepSeek].inputTokensPerMillion);
        setOutputPrice(DEFAULT_TOKEN_PRICING_MAP[Model.DeepSeek].outputTokensPerMillion);
        setAdvanced("");
      }
      setFetchedModels([]);
      setCustomModelInput("");
    }
  }, [open, profile]);

  // A result belongs to the values it was tested with.
  useEffect(() => {
    testRun.current += 1;
    setTest({ status: "idle" });
  }, [open, apiKey, baseUrl, modelKey, apiFormat, outputTokenParameter]);

  const handleProviderChange = (p: Model) => {
    setProvider(p);
    setBaseUrl(DEFAULT_MODEL_BASE_URL_MAP[p]);
    setModelKey(DEFAULT_MODEL_KEY_MAP[p]);
    setApiFormat(DEFAULT_MODEL_API_FORMAT_MAP[p]);
    setOutputTokenParameter(DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP[p]);
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
      apiKey: apiKey.trim(),
      baseUrl,
      modelKey,
      apiFormat,
      outputTokenParameter,
      tokenPricing: {
        inputTokensPerMillion: inputPrice,
        outputTokensPerMillion: outputPrice,
      },
    };

    if (isNew) {
      const id = addProfile(data);
      const { assignment } = useModelStore.getState();
      if (assignment.agent === id || assignment.taskExecution === id) {
        toast.success(t("setting:fields.profile.auto_assigned"));
      }
      onSaved?.(id, true);
    } else {
      updateProfile(profile!.id, data);
      onSaved?.(profile!.id, false);
    }
    onOpenChange(false);
  };

  /**
   * A next-step button (for example "open network settings") leads away from the form: keep what
   * was typed so the form comes back filled in, and offer the way back.
   */
  const leaveForm = () => {
    useModelProfileDraftStore.getState().keep({
      owner: draftOwner,
      profileId: profile?.id ?? null,
      values: { name, provider, apiKey, baseUrl, modelKey, apiFormat, outputTokenParameter, inputPrice, outputPrice },
    });
    onOpenChange(false);
    onLeave?.();
    // The wizard offers its own way back.
    if (draftOwner !== "settings") return;
    toast(t("setting:fields.connection_test.draft_kept"), {
      id: "model-profile-draft",
      duration: DRAFT_NOTICE_MS,
      action: {
        label: t("setting:fields.connection_test.draft_continue"),
        onClick: () => {
          useModelProfileDraftStore.getState().requestReopen();
          navigate(settingPath("model"));
        },
      },
    });
  };

  const canTest = !!window.modelSetup && !!apiKey.trim();
  const runTest = async () => {
    const api = window.modelSetup;
    if (!api || !apiKey.trim()) return;
    const run = ++testRun.current;
    setTest({ status: "testing" });
    try {
      const result = await api.testConnection({
        baseUrl,
        apiFormat,
        modelKey,
        apiKey: apiKey.trim(),
        ...(apiFormat === "chat_completions" ? { outputTokenParameter } : {}),
      });
      if (run === testRun.current) setTest({ status: "done", result });
    } catch {
      if (run === testRun.current) setTest({ status: "done", result: { ok: false, latencyMs: 0, category: "unknown" } });
    }
  };

  // OpenAI model fetching
  const fetchOpenAIModels = useCallback(async () => {
    if (!apiKey) {
      toast.error(t("setting:fields.model_fetch.no_key"));
      return;
    }
    setIsFetchingModels(true);
    try {
      const modelsUrl = normalizeModelEndpoint(
        baseUrl || DEFAULT_MODEL_BASE_URL_MAP[Model.OpenAI],
      ).modelsUrl;
      const response = await fetch(modelsUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      // The body says why a request was refused (a wrong key, no balance); a web page means a wrong address.
      const body = await response.text();
      let data: { data?: unknown[] };
      try {
        data = JSON.parse(body);
      } catch {
        throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, responseBody: body });
      }
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, responseBody: body });
      const models: string[] = (data.data || [])
        .map((m: any) => m.id as string)
        .filter((id: string) => {
          const lower = id.toLowerCase();
          return !MODEL_EXCLUDE_PATTERNS.some((p) => lower.includes(p));
        })
        .sort();
      setFetchedModels(models);
      toast.success(t("setting:fields.model_fetch.success", { count: models.length }));
    } catch (error) {
      // The same cause and next step as "Test connection" gives for this kind of failure.
      const guide = modelErrorGuide(classifyModelError(error), { provider, baseUrl }, "connection_test");
      toast.error(t("setting:fields.model_fetch.error"), { description: `${t(guide.causeKey)} ${t(guide.nextKey)}` });
    } finally {
      setIsFetchingModels(false);
    }
  }, [apiKey, baseUrl, provider, t]);

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

  const handleDeepSeekModelChange = (val: string) => {
    setModelKey(val);
    const matchedPreset = DEEPSEEK_MODEL_OPTIONS.find((o) => o.value === val);
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

  const advancedOpen = advanced === ADVANCED_SECTION;

  return (
    <ScrollableDialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidth="sm:max-w-xl"
      animateSize
    >
      <ScrollableDialogHeader>
        <DialogTitle>
          {isNew
            ? t("setting:fields.profile.dialog_title_add")
            : t("setting:fields.profile.dialog_title_edit")}
        </DialogTitle>
        <DialogDescription>
          {t("setting:fields.profile.dialog_description")}
        </DialogDescription>
      </ScrollableDialogHeader>

      <ScrollableDialogContent fadeMasks>
        <div className="space-y-5" data-testid="model-profile-form">
          {/* Profile Name */}
          <div className="space-y-2">
            <Label htmlFor="model-profile-name">{t("setting:fields.profile.name")}</Label>
            <Input
              id="model-profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("setting:fields.profile.name_placeholder")}
            />
          </div>

          {/* Provider */}
          <div className="space-y-2">
            <Label>{t("setting:fields.model_type")}</Label>
            <SegmentedControl
              size="sm"
              fullWidth
              value={provider}
              aria-label={t("setting:fields.model_type")}
              items={[
                {
                  value: Model.DeepSeek,
                  label: (
                    <span className="inline-flex items-center gap-1">
                      DeepSeek
                      <span className="rounded-full bg-emerald-500/15 px-1.5 text-[10px] leading-4 text-emerald-700 dark:text-emerald-400">
                        {t("setting:fields.model_fetch.badge_recommended")}
                      </span>
                    </span>
                  ),
                  ariaLabel: t("setting:fields.deepseek_recommended_aria"),
                },
                { value: Model.OpenAI, label: "OpenAI" },
                { value: Model.Other, label: t("setting:fields.other") },
              ]}
              onValueChange={(value) => handleProviderChange(value as Model)}
            />
            {provider === Model.DeepSeek && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="deepseek-links">
                <span>{t("setting:fields.deepseek_intro")}</span>
                <a
                  href={DEEPSEEK_API_KEYS_URL}
                  onClick={(event) => { event.preventDefault(); openExternalPage(DEEPSEEK_API_KEYS_URL); }}
                  className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-3 hover:underline"
                >
                  {t("setting:fields.deepseek_get_key")}<ExternalLink className="size-3" />
                </a>
                <a
                  href={DEEPSEEK_TOP_UP_URL}
                  onClick={(event) => { event.preventDefault(); openExternalPage(DEEPSEEK_TOP_UP_URL); }}
                  className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-3 hover:underline"
                >
                  {t("setting:fields.deepseek_top_up")}<ExternalLink className="size-3" />
                </a>
              </p>
            )}
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label htmlFor="model-profile-api-key">{t("setting:fields.apikey")}</Label>
            <ApiKeyInput
              id="model-profile-api-key"
              data-testid="model-profile-api-key"
              placeholder={t("setting:placeholder.apikey")}
              value={apiKey}
              onValueChange={setApiKey}
            />
          </div>

          {/* Base URL */}
          <div className="space-y-2">
            <Label htmlFor="model-profile-base-url">{t("setting:fields.model_url")}</Label>
            <Input
              id="model-profile-base-url"
              placeholder={t("setting:placeholder.model_url")}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {provider === Model.Other
                ? t("setting:fields.api_format.base_url_hint_other")
                : apiFormat === "responses"
                  ? t("setting:fields.api_format.base_url_hint_responses")
                  : t("setting:fields.api_format.base_url_hint_chat")}
            </p>
          </div>

          {/* DeepSeek Model Selector */}
          {provider === Model.DeepSeek && (
            <div className="space-y-2">
              <Label>{t("setting:fields.model_name")}</Label>
              <Select value={modelKey} onValueChange={handleDeepSeekModelChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>{t("setting:fields.model_fetch.preset_group")}</SelectLabel>
                    {DEEPSEEK_MODEL_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <span className="flex items-center gap-2">
                          <span>{option.label}</span>
                          <span className="text-muted-foreground text-xs font-mono">{option.value}</span>
                          {option.badge && (
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] px-1.5 py-0 ml-1",
                                option.badge === "legacy"
                                  ? "text-muted-foreground border-muted-foreground/30"
                                  : option.badge === "flagship"
                                    ? "text-purple-600 dark:text-purple-400 border-purple-500/30"
                                    : "text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                              )}
                            >
                              {t(`setting:fields.model_fetch.badge_${option.badge}`)}
                            </Badge>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {DEEPSEEK_MODEL_OPTIONS.find((o) => o.value === modelKey)?.badge === "legacy" && (
                <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {t("setting:fields.model_fetch.deepseek_legacy_warning")}
                </p>
              )}
            </div>
          )}

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
                        aria-label={t("setting:fields.model_fetch.refresh_tooltip")}
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
                <div className="flex justify-between items-center gap-2">
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

          {/* Other: model name */}
          {provider === Model.Other && (
            <div className="space-y-2">
              <Label htmlFor="model-profile-model-key">{t("setting:fields.model_key")}</Label>
              <Input
                id="model-profile-model-key"
                placeholder={t("setting:placeholder.model_key")}
                value={modelKey}
                onChange={(e) => setModelKey(e.target.value)}
              />
            </div>
          )}

          {/* Advanced: API format, output token parameter, prices. A preset sets them. */}
          <Accordion
            type="single"
            collapsible
            value={advanced}
            onValueChange={setAdvanced}
            data-testid="model-profile-advanced"
            className="min-w-0 rounded-smooth-[12px] border bg-card"
          >
            <AccordionItem value={ADVANCED_SECTION} className="border-0">
              <AccordionTrigger className="min-h-11 w-full cursor-pointer rounded-smooth-[11px] px-3 data-[state=open]:rounded-b-none">
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5 [overflow-wrap:anywhere]">
                  <span className="leading-5">{t("setting:fields.advanced.title")}</span>
                  <span className="text-xs font-normal leading-5 text-muted-foreground">{t("setting:fields.advanced.description")}</span>
                </span>
              </AccordionTrigger>
              <AccordionContent
                forceMount
                motionOpen={advancedOpen}
                aria-hidden={!advancedOpen}
                inert={!advancedOpen}
                className="space-y-5 px-3 pb-3 pt-1"
              >
                {/* API Format */}
                <div className="space-y-2">
                  <Label>{t("setting:fields.api_format.label")}</Label>
                  <SegmentedControl
                    size="sm"
                    fullWidth
                    value={apiFormat}
                    aria-label={t("setting:fields.api_format.label")}
                    items={(["responses", "chat_completions"] as const).map(
                      (value) => ({
                        value,
                        label: t(`setting:fields.api_format.${value}`),
                      }),
                    )}
                    onValueChange={(value) => setApiFormat(value as ModelApiFormat)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {apiFormat === "responses"
                      ? t("setting:fields.api_format.responses_hint")
                      : t("setting:fields.api_format.chat_hint")}
                  </p>
                </div>

                {/* Chat Completions token parameter */}
                {apiFormat === "chat_completions" && (
                  <div className="space-y-2">
                    <Label>{t("setting:fields.api_format.output_token_parameter")}</Label>
                    <Select
                      value={outputTokenParameter}
                      onValueChange={(value) =>
                        setOutputTokenParameter(value as OutputTokenParameter)
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="max_tokens">
                          {t("setting:fields.api_format.max_tokens")}
                        </SelectItem>
                        <SelectItem value="max_completion_tokens">
                          {t("setting:fields.api_format.max_completion_tokens")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {t("setting:fields.api_format.output_token_parameter_hint")}
                    </p>
                  </div>
                )}

                {/* Token Pricing */}
                <div className="space-y-3">
                  <Label>{t("setting:subtitle.token_price_config")}</Label>
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
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          <DialogTransition transitionKey={test.status === "done" ? `done-${test.result.category}` : test.status}>
            {test.status !== "idle" && (
              <ConnectionTestStatus
                state={test}
                profile={{ provider, baseUrl }}
                excludeActions={["open_model_settings"]}
                onBeforeAction={leaveForm}
              />
            )}
          </DialogTransition>
        </div>
      </ScrollableDialogContent>

      <ScrollableDialogFooter className="flex flex-wrap items-center justify-between gap-2">
        {window.modelSetup ? (
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              {/* A disabled button gets no pointer events; the wrapper keeps the hint. */}
              <span tabIndex={canTest ? -1 : 0}>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="model-profile-test"
                  disabled={!canTest || test.status === "testing"}
                  onClick={() => void runTest()}
                >
                  {test.status === "testing" ? <Loader2 className="animate-spin" /> : <PlugZap />}
                  {t("setting:fields.connection_test.button")}
                </Button>
              </span>
            </TooltipTrigger>
            {!canTest && <TooltipContent side="top">{t("setting:fields.connection_test.need_key")}</TooltipContent>}
          </Tooltip>
        ) : <span />}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("setting:fields.profile.cancel")}
          </Button>
          <Button onClick={handleSave} data-testid="model-profile-save">
            {isNew
              ? t("setting:fields.profile.create")
              : t("setting:fields.profile.save")}
          </Button>
        </div>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  );
}

export default ModelProfileDialog;
