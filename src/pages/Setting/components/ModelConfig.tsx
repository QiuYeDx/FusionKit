import { useState, useCallback, useMemo, useEffect } from "react";
import useModelStore from "@/store/useModelStore";
import { Model } from "@/type/model";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ButtonGroup } from "@/components/ui/button-group";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
import { OPENAI_MODEL_OPTIONS, DEFAULT_MODEL_URL_MAP } from "@/constants/model";
import { RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";

const MODEL_EXCLUDE_PATTERNS = [
  "embed", "whisper", "tts", "dall-e", "moderation",
  "audio", "realtime", "transcri", "search", "similarity",
  "code-", "text-", "if-", "canary",
];

function ModelConfig() {
  const { t } = useTranslation(); // 使用 useTranslation Hook 获取 t 函数
  const {
    model,
    apiKeyMap,
    modelUrlMap,
    modelKeyMap,
    tokenPricingMap,
    setModel,
    setApiKeyByType,
    setModelUrlByType,
    setModelKeyByType,
    setTokenPricingByType,
  } = useModelStore();

  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [customOpenAiModelInput, setCustomOpenAiModelInput] = useState("");

  const openAiModelKey = modelKeyMap[Model.OpenAI];

  useEffect(() => {
    setCustomOpenAiModelInput("");
  }, [openAiModelKey]);

  const fetchOpenAIModels = useCallback(async () => {
    const apiKey = apiKeyMap[Model.OpenAI];
    if (!apiKey) {
      toast.error(t("setting:fields.model_fetch.no_key"));
      return;
    }
    setIsFetchingModels(true);
    try {
      const baseUrl =
        modelUrlMap[Model.OpenAI] || DEFAULT_MODEL_URL_MAP[Model.OpenAI];
      const modelsUrl = baseUrl.replace(/\/chat\/completions\/?$/, "/models");
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
      toast.success(
        t("setting:fields.model_fetch.success", { count: models.length })
      );
    } catch (err) {
      console.error("Failed to fetch OpenAI models:", err);
      toast.error(t("setting:fields.model_fetch.error"));
    } finally {
      setIsFetchingModels(false);
    }
  }, [apiKeyMap, modelUrlMap, t]);

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
  const hasCustomKey = openAiModelKey && !allKnownValues.has(openAiModelKey);

  const resolvedOpenAiPricing =
    OPENAI_MODEL_OPTIONS.find((option) => option.value === openAiModelKey)
      ?.pricing ??
    tokenPricingMap[Model.OpenAI] ??
    OPENAI_MODEL_OPTIONS[0].pricing;
  const inputTokenPlaceholder =
    model === Model.OpenAI
      ? resolvedOpenAiPricing.inputTokensPerMillion.toFixed(2)
      : "1.5";
  const outputTokenPlaceholder =
    model === Model.OpenAI
      ? resolvedOpenAiPricing.outputTokensPerMillion.toFixed(2)
      : "2.0";

  const handleApiKeyChange = (e: any) => {
    const val = e.target.value;
    setApiKeyByType(model, val);
  };

  const handleModelUrlChange = (e: any) => {
    const val = e.target.value;
    setModelUrlByType(model, val);
  };

  const handleModelKeyChange = (e: any) => {
    const val = e.target.value;
    setModelKeyByType(model, val);
  };

  const handleOpenAiModelChange = (val: string) => {
    setModelKeyByType(Model.OpenAI, val);
    const matchedPreset = OPENAI_MODEL_OPTIONS.find(
      (option) => option.value === val
    );
    if (matchedPreset) {
      setTokenPricingByType(Model.OpenAI, { ...matchedPreset.pricing });
    }
  };

  const handleApplyCustomOpenAiModelKey = () => {
    const customModelKey = customOpenAiModelInput.trim();
    if (!customModelKey) {
      toast.error(t("setting:fields.model_fetch.empty_custom_key"));
      return;
    }
    handleOpenAiModelChange(customModelKey);
  };

  const handleInputTokenPriceChange = (e: any) => {
    const val = parseFloat(e.target.value) || 0;
    const currentPricing = tokenPricingMap[model];
    setTokenPricingByType(model, {
      ...currentPricing,
      inputTokensPerMillion: val,
    });
  };

  const handleOutputTokenPriceChange = (e: any) => {
    const val = parseFloat(e.target.value) || 0;
    const currentPricing = tokenPricingMap[model];
    setTokenPricingByType(model, {
      ...currentPricing,
      outputTokensPerMillion: val,
    });
  };

  return (
    <Card className="overflow-auto">
      <CardHeader className="sticky left-0">
        <CardTitle className="text-xl">
          {t("setting:subtitle.apikey_config")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 模型类型 选择 */}
        <div className="flex items-center gap-4">
          <Label className="text-sm font-medium min-w-[80px]">
            {t("setting:fields.model_type")}
          </Label>
          <ButtonGroup>
            <Button
              size="sm"
              variant={model === Model.DeepSeek ? "default" : "outline"}
              onClick={() => setModel(Model.DeepSeek)}
            >
              DeepSeek
            </Button>
            <Button
              size="sm"
              variant={model === Model.OpenAI ? "default" : "outline"}
              onClick={() => setModel(Model.OpenAI)}
            >
              OpenAI
            </Button>
            <Button
              size="sm"
              variant={model === Model.Other ? "default" : "outline"}
              onClick={() => setModel(Model.Other)}
            >
              {t("setting:fields.other")}
            </Button>
          </ButtonGroup>
        </div>

        {/* 模型 apiKey 输入 */}
        <div className="w-full max-w-2xl space-y-2">
          <div className="flex justify-between items-center">
            <Label htmlFor="api-key">{t("setting:fields.apikey")}</Label>
            <span className="text-sm text-muted-foreground">
              {model === Model.Other ? t(`setting:fields.other`) : model}
            </span>
          </div>
          <Input
            id="api-key"
            type="text"
            placeholder={t("setting:placeholder.apikey")}
            value={apiKeyMap[model]}
            onChange={handleApiKeyChange}
            className="w-full"
          />
        </div>

        {/* OpenAI 模型选择 */}
        {model === Model.OpenAI && (
          <div className="w-full max-w-2xl space-y-2">
            <div className="flex justify-between items-center">
              <Label htmlFor="openai-model">
                {t("setting:fields.model_name")}
              </Label>
              <span className="text-sm text-muted-foreground">OpenAI</span>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={openAiModelKey}
                onValueChange={handleOpenAiModelChange}
              >
                <SelectTrigger id="openai-model" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>
                      {t("setting:fields.model_fetch.preset_group")}
                    </SelectLabel>
                    {OPENAI_MODEL_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <span className="flex items-center gap-2">
                          <span>{option.label}</span>
                          <span className="text-muted-foreground text-xs font-mono">
                            {option.value}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  {remoteOnlyModels.length > 0 && (
                    <>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel>
                          {t("setting:fields.model_fetch.remote_group")}
                        </SelectLabel>
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
                      <SelectItem value={openAiModelKey}>
                        <span className="flex items-center gap-2">
                          <span>{openAiModelKey}</span>
                          <span className="text-muted-foreground text-xs">
                            ({t("setting:fields.other")})
                          </span>
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
                    aria-label={t("setting:fields.model_fetch.refresh_tooltip")}
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
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <Label htmlFor="openai-model-key-input">
                  {t("setting:fields.model_fetch.manual_key_label")}
                </Label>
                <span className="text-xs text-muted-foreground">
                  {t("setting:fields.model_fetch.manual_key_hint")}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="openai-model-key-input"
                  type="text"
                  placeholder={t("setting:placeholder.model_key")}
                  value={customOpenAiModelInput}
                  onChange={(e) => setCustomOpenAiModelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleApplyCustomOpenAiModelKey();
                    }
                  }}
                  className="w-full"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleApplyCustomOpenAiModelKey}
                >
                  {t("setting:fields.model_fetch.apply_custom_key")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 自定义模型 URL 输入 */}
        {model === Model.Other && (
          <div className="w-full max-w-2xl space-y-2">
            <div className="flex justify-between items-center">
              <Label htmlFor="model-url">{t("setting:fields.model_url")}</Label>
              <span className="text-sm text-muted-foreground">
                {model === Model.Other ? t(`setting:fields.other`) : model}
              </span>
            </div>
            <Input
              id="model-url"
              type="text"
              placeholder={
                t("setting:placeholder.model_url") +
                "(https://.../v1/chat/completions)"
              }
              value={modelUrlMap[model]}
              disabled={[Model.DeepSeek, Model.OpenAI].includes(model)}
              onChange={handleModelUrlChange}
              className="w-full"
            />
          </div>
        )}

        {/* 自定义模型 Key 输入 */}
        {model === Model.Other && (
          <div className="w-full max-w-2xl space-y-2">
            <div className="flex justify-between items-center">
              <Label htmlFor="model-key">{t("setting:fields.model_key")}</Label>
              <span className="text-sm text-muted-foreground">
                {model === Model.Other ? t(`setting:fields.other`) : model}
              </span>
            </div>
            <Input
              id="model-key"
              type="text"
              placeholder={t("setting:placeholder.model_key")}
              value={modelKeyMap[model]}
              disabled={[Model.DeepSeek, Model.OpenAI].includes(model)}
              onChange={handleModelKeyChange}
              className="w-full"
            />
          </div>
        )}

        {/* Token价格配置 */}
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold mb-2">
              {t("setting:subtitle.token_price_config")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("setting:fields.token_price.intro_desc")}
              {model !== Model.Other && " "}
              {model !== Model.Other &&
                t("setting:fields.token_price.intro_desc_preset")}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
            {/* 输入Token价格 */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <Label htmlFor="input-token-price">
                  {t("setting:fields.token_price.input_price")}
                </Label>
                <span className="text-sm text-muted-foreground">
                  {t("setting:fields.token_price.per_million")}
                </span>
              </div>
              <Input
                id="input-token-price"
                type="number"
                step="0.01"
                min="0"
                placeholder={inputTokenPlaceholder}
                value={tokenPricingMap[model]?.inputTokensPerMillion || ""}
                onChange={handleInputTokenPriceChange}
                className="w-full"
              />
            </div>

            {/* 输出Token价格 */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <Label htmlFor="output-token-price">
                  {t("setting:fields.token_price.output_price")}
                </Label>
                <span className="text-sm text-muted-foreground">
                  {t("setting:fields.token_price.per_million")}
                </span>
              </div>
              <Input
                id="output-token-price"
                type="number"
                step="0.01"
                min="0"
                placeholder={outputTokenPlaceholder}
                value={tokenPricingMap[model]?.outputTokensPerMillion || ""}
                onChange={handleOutputTokenPriceChange}
                className="w-full"
              />
            </div>
          </div>

          {/* 当前模型价格展示 */}
          <div className="p-4 bg-muted rounded-lg max-w-2xl space-y-2">
            <div className="text-sm text-muted-foreground">
              {t("setting:fields.token_price.current_price_title").replace(
                "{model}",
                model === Model.Other
                  ? t("setting:fields.token_price.custom_model")
                  : model
              )}
            </div>
            <div className="font-mono text-sm">
              {t("setting:fields.token_price.input_label")} $
              {tokenPricingMap[model]?.inputTokensPerMillion?.toFixed(2) ||
                "0.00"}
              /1M tokens
            </div>
            <div className="font-mono text-sm">
              {t("setting:fields.token_price.output_label")} $
              {tokenPricingMap[model]?.outputTokensPerMillion?.toFixed(2) ||
                "0.00"}
              /1M tokens
            </div>
          </div>

          {model !== Model.Other && (
            <div className="text-xs text-orange-500 max-w-2xl">
              {t("setting:fields.token_price.preset_note").replace(
                "{model}",
                model
              )}
            </div>
          )}

          {model === Model.Other && (
            <div className="text-xs text-blue-500 max-w-2xl">
              {t("setting:fields.token_price.custom_note")}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default ModelConfig;
