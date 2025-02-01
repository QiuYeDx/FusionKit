import {
  DEFAULT_APIKEY_MAP,
  DEFAULT_MODEL,
  DEFAULT_MODEL_URL_MAP,
} from "@/constants/model";
import { ApiKeyMap, Model, ModelUrlMap } from "@/type/model";
import { create } from "zustand";
import { cloneDeep } from "lodash";

interface ModelStore {
  model: Model;
  modelUrlMap: ModelUrlMap;
  apiKeyMap: ApiKeyMap;
  setModel: (newModel: Model) => void; // 设置当前使用的模型类型
  setModelUrlByType: (modelType: Model, newModelUrl: string) => void; // 设置指定模型的 URL
  setApiKeyByType: (modelType: Model, newApiKey: string) => void; // 设置指定模型的 ApiKey
  initializeModel: () => void;
}

const useModelStore = create<ModelStore>((set, get) => {
  // 初始化模型配置
  const initializeModel = () => {
    const modelConfig = JSON.parse(localStorage.getItem("modelConfig") ?? "{}");
    const initialModel = modelConfig?.model || DEFAULT_MODEL;
    const modelUrlMap = modelConfig?.modelUrlMap || DEFAULT_MODEL_URL_MAP;
    const apiKeyMap = modelConfig?.apiKeyMap || DEFAULT_APIKEY_MAP;
    set({
      model: initialModel,
      modelUrlMap,
      apiKeyMap,
    });
  };

  const _memoryInLocalStorage = () => {
    const state = get();
    const ans = {
      model: state.model,
      modelUrlMap: state.modelUrlMap,
      apiKeyMap: state.apiKeyMap,
    };
    localStorage.setItem("modelConfig", JSON.stringify(ans));
  };

  const setModel = (newModel: Model) => {
    set({
      model: newModel,
    });

    _memoryInLocalStorage();
  };

  const setModelUrlByType = (modelType: Model, newModelUrl: string) => {
    const newModelUrlMap = cloneDeep(get().modelUrlMap);
    newModelUrlMap[modelType] = newModelUrl;
    set({
      modelUrlMap: newModelUrlMap,
    });
    _memoryInLocalStorage();
  };

  const setApiKeyByType = (modelType: Model, newApiKey: string) => {
    const newApiKeyMap = cloneDeep(get().apiKeyMap);
    newApiKeyMap[modelType] = newApiKey;
    set({
      apiKeyMap: newApiKeyMap,
    });
    _memoryInLocalStorage();
  };

  return {
    model: DEFAULT_MODEL,
    modelUrlMap: DEFAULT_MODEL_URL_MAP,
    apiKeyMap: DEFAULT_APIKEY_MAP,
    setModel,
    setModelUrlByType,
    setApiKeyByType,
    initializeModel,
  };
});

export default useModelStore;
