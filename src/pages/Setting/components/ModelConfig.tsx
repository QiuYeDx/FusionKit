import useModelStore from "@/store/useModelStore";
import { Model } from "@/type/model";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ButtonGroup } from "@/components/ui/button-group";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

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
    <Card className="mb-16 overflow-auto">
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
                placeholder="1.5"
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
                placeholder="2.0"
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
