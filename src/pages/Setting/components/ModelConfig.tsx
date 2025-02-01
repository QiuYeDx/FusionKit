import useModelStore from "@/store/useModelStore";
import { Model } from "@/type/model";
import { useTranslation } from "react-i18next";

function ModelConfig() {
  const { t } = useTranslation(); // 使用 useTranslation Hook 获取 t 函数
  const {
    model,
    apiKeyMap,
    modelUrlMap,
    setModel,
    setApiKeyByType,
    setModelUrlByType,
  } = useModelStore();

  const handleApiKeyChange = (e: any) => {
    const val = e.target.value;
    setApiKeyByType(model, val);
  };

  const handleModelUrlChange = (e: any) => {
    const val = e.target.value;
    setModelUrlByType(model, val);
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
      <label className="form-control w-full max-w-xs">
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
          className="input input-sm input-bordered box-border w-full max-w-xs"
        />
      </label>

      {/* 自定义模型 URL 输入 */}
      {model === Model.Other && (
        <label className="form-control w-full max-w-xs">
          <div className="label mt-1 -mb-1 shrink-0">
            <span className="label-text">{t("setting:fields.model_url")}</span>
            <span className="label-text-alt">
              {model === Model.Other ? t(`setting:fields.other`) : model}
            </span>
          </div>
          <input
            type="text"
            placeholder={t("setting:placeholder.model_url")}
            value={modelUrlMap[model]}
            disabled={[Model.DeepSeek, Model.OpenAI].includes(model)}
            onChange={handleModelUrlChange}
            className="input input-sm input-bordered box-border w-full max-w-xs shrink-0"
          />
        </label>
      )}
    </div>
  );
}

export default ModelConfig;
