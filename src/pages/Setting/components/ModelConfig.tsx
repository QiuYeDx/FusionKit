import useModelStore from "@/store/useModelStore";
import { Model } from "@/type/model";
import { useTranslation } from "react-i18next";
import { useState } from "react";

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
    <div className="bg-base-200 mb-16 p-4 rounded-lg overflow-auto">
      <div className="text-xl font-semibold mb-4 sticky left-0">
        {t("setting:subtitle.apikey_config")}
      </div>

      {/* 模型类型 选择 */}
      <div className="join -ml-1">
        <input
          className="join-item btn btn-sm bg-base-100"
          type="radio"
          name="model"
          aria-label="DeepSeek"
          checked={model === Model.DeepSeek}
          onChange={() => setModel(Model.DeepSeek)}
        />
        <input
          className="join-item btn btn-sm bg-base-100 mt-[3px]"
          type="radio"
          name="model"
          aria-label="OpenAI"
          checked={model === Model.OpenAI}
          onChange={() => setModel(Model.OpenAI)}
        />
        <input
          className="join-item btn btn-sm bg-base-100 mt-[3px]"
          type="radio"
          name="model"
          aria-label={t("setting:fields.other")}
          checked={model === Model.Other}
          onChange={() => setModel(Model.Other)}
        />
      </div>

      {/* 模型 apiKey 输入 */}
      <label className="form-control w-full max-w-2xl">
        <div className="label mt-1 -mb-1">
          <span className="label-text">{t("setting:fields.apikey")}</span>
          <span className="label-text-alt">
            {model === Model.Other ? t(`setting:fields.other`) : model}
          </span>
        </div>
        <input
          type="text"
          placeholder={t("setting:placeholder.apikey")}
          value={apiKeyMap[model]}
          onChange={handleApiKeyChange}
          className="input input-sm input-bordered box-border w-full max-w-2xl"
        />
      </label>

      {/* 自定义模型 URL 输入 */}
      {model === Model.Other && (
        <label className="form-control w-full max-w-2xl">
          <div className="label mt-1 -mb-1 shrink-0">
            <span className="label-text">{t("setting:fields.model_url")}</span>
            <span className="label-text-alt">
              {model === Model.Other ? t(`setting:fields.other`) : model}
            </span>
          </div>
          <input
            type="text"
            placeholder={t("setting:placeholder.model_url") + '(https://.../v1/chat/completions)'}
            value={modelUrlMap[model]}
            disabled={[Model.DeepSeek, Model.OpenAI].includes(model)}
            onChange={handleModelUrlChange}
            className="input input-sm input-bordered box-border w-full max-w-2xl shrink-0"
          />
        </label>
      )}

      {/* 自定义模型 Key 输入 */}
      {model === Model.Other && (
        <label className="form-control w-full max-w-2xl">
          <div className="label mt-1 -mb-1 shrink-0">
            <span className="label-text">{t("setting:fields.model_key")}</span>
            <span className="label-text-alt">
              {model === Model.Other ? t(`setting:fields.other`) : model}
            </span>
          </div>
          <input
            type="text"
            placeholder={t("setting:placeholder.model_key")}
            value={modelKeyMap[model]}
            disabled={[Model.DeepSeek, Model.OpenAI].includes(model)}
            onChange={handleModelKeyChange}
            className="input input-sm input-bordered box-border w-full max-w-2xl shrink-0"
          />
        </label>
      )}

      {/* Token价格配置 */}
      <div className="mt-6">
        <div className="text-lg font-semibold mb-3">Token 价格配置</div>
        <div className="text-sm text-gray-600 dark:text-gray-300 mb-4">
          配置每1M tokens的价格（美元）。
          {model !== Model.Other && "预设模型的价格可以调整，但建议使用官方定价。"}
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
          {/* 输入Token价格 */}
          <label className="form-control">
            <div className="label -mb-1">
              <span className="label-text">输入Token价格</span>
              <span className="label-text-alt">$/1M tokens</span>
            </div>
            <input
              type="number"
              step="0.01"
              min="0"
              placeholder="1.5"
              value={tokenPricingMap[model]?.inputTokensPerMillion || ''}
              onChange={handleInputTokenPriceChange}
              className="input input-sm input-bordered box-border w-full"
            />
          </label>

          {/* 输出Token价格 */}
          <label className="form-control">
            <div className="label -mb-1">
              <span className="label-text">输出Token价格</span>
              <span className="label-text-alt">$/1M tokens</span>
            </div>
            <input
              type="number"
              step="0.01"
              min="0"
              placeholder="2.0"
              value={tokenPricingMap[model]?.outputTokensPerMillion || ''}
              onChange={handleOutputTokenPriceChange}
              className="input input-sm input-bordered box-border w-full"
            />
          </label>
        </div>

        {/* 当前模型价格展示 */}
        <div className="mt-4 p-3 bg-base-100 rounded-lg max-w-2xl">
          <div className="text-sm text-gray-600 dark:text-gray-300 mb-2">
            当前 {model === Model.Other ? "自定义模型" : model} 的Token价格：
          </div>
          <div className="font-mono text-sm">
            输入: ${tokenPricingMap[model]?.inputTokensPerMillion?.toFixed(2) || '0.00'}/1M tokens
          </div>
          <div className="font-mono text-sm">
            输出: ${tokenPricingMap[model]?.outputTokensPerMillion?.toFixed(2) || '0.00'}/1M tokens
          </div>
        </div>

        {model !== Model.Other && (
          <div className="mt-3 text-xs text-orange-600 max-w-2xl">
            注意：{model} 的价格已根据官方定价预设。您可以根据实际情况调整价格，但建议使用官方定价以确保准确性。
          </div>
        )}
        
        {model === Model.Other && (
          <div className="mt-3 text-xs text-blue-600 max-w-2xl">
            提示：请根据您使用的自定义模型的实际定价设置Token价格，以获得准确的费用预估。
          </div>
        )}
      </div>
    </div>
  );
}

export default ModelConfig;
