import {
  DEFAULT_APIKEY_MAP,
  DEFAULT_MODEL,
  DEFAULT_MODEL_KEY_MAP,
  DEFAULT_MODEL_URL_MAP,
  DEFAULT_TOKEN_PRICING_MAP,
} from "@/constants/model";
import { ApiKeyMap, Model, ModelKeyMap, ModelUrlMap, TokenPricingMap, TokenPricing } from "@/type/model";
import { create } from "zustand";
import { cloneDeep } from "lodash";

interface ModelStore {
  model: Model;
  modelUrlMap: ModelUrlMap;
  modelKeyMap: ModelKeyMap;
  apiKeyMap: ApiKeyMap;
  tokenPricingMap: TokenPricingMap;
  getApiKeyByType: (modelType: Model) => string; // 获取指定模型的 ApiKey
  getModelKeyByType: (modelType: Model) => string; // 获取指定模型的 Key(具体使用的模型 Key)
  getModelUrlByType: (modelType: Model) => string; // 获取指定模型的 URL
  getTokenPricingByType: (modelType: Model) => TokenPricing; // 获取指定模型的Token价格
  setModel: (newModel: Model) => void; // 设置当前使用的模型类型
  setModelKeyByType: (modelType: Model, newModelKey: string) => void; // 设置指定模型的 Key(具体使用的模型 Key)
  setModelUrlByType: (modelType: Model, newModelUrl: string) => void; // 设置指定模型的 URL
  setApiKeyByType: (modelType: Model, newApiKey: string) => void; // 设置指定模型的 ApiKey
  setTokenPricingByType: (modelType: Model, pricing: TokenPricing) => void; // 设置指定模型的Token价格
  initializeModel: () => void;
}

const useModelStore = create<ModelStore>((set, get) => {
  // 初始化模型配置
  const initializeModel = () => {
    const modelConfig = JSON.parse(localStorage.getItem("modelConfig") ?? "{}");
    const initialModel = modelConfig?.model || DEFAULT_MODEL;
    const modelUrlMap = modelConfig?.modelUrlMap || DEFAULT_MODEL_URL_MAP;
    const modelKeyMap = modelConfig?.modelKeyMap || DEFAULT_MODEL_KEY_MAP;
    const apiKeyMap = modelConfig?.apiKeyMap || DEFAULT_APIKEY_MAP;
    const tokenPricingMap = modelConfig?.tokenPricingMap || DEFAULT_TOKEN_PRICING_MAP;
    set({
      model: initialModel,
      modelUrlMap,
      modelKeyMap,
      apiKeyMap,
      tokenPricingMap,
    });
  };

  const _memoryInLocalStorage = () => {
    const state = get();
    const ans = {
      model: state.model,
      modelUrlMap: state.modelUrlMap,
      modelKeyMap: state.modelKeyMap,
      apiKeyMap: state.apiKeyMap,
      tokenPricingMap: state.tokenPricingMap,
    };
    localStorage.setItem("modelConfig", JSON.stringify(ans));
  };

  const getApiKeyByType = (modelType: Model) => {
    return get().apiKeyMap[modelType];
  };

  const getModelKeyByType = (modelType: Model) => {
    return get().modelKeyMap[modelType];
  };

  const getModelUrlByType = (modelType: Model) => {
    return get().modelUrlMap[modelType];
  };

  const getTokenPricingByType = (modelType: Model) => {
    return get().tokenPricingMap[modelType];
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

  const setModelKeyByType = (modelType: Model, newModelKey: string) => {
    const newModelKeyMap = cloneDeep(get().modelKeyMap);
    newModelKeyMap[modelType] = newModelKey;
    set({
      modelKeyMap: newModelKeyMap,
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

  const setTokenPricingByType = (modelType: Model, pricing: TokenPricing) => {
    const newTokenPricingMap = cloneDeep(get().tokenPricingMap);
    newTokenPricingMap[modelType] = pricing;
    set({
      tokenPricingMap: newTokenPricingMap,
    });
    _memoryInLocalStorage();
  };

  return {
    model: DEFAULT_MODEL,
    modelUrlMap: DEFAULT_MODEL_URL_MAP,
    modelKeyMap: DEFAULT_MODEL_KEY_MAP,
    apiKeyMap: DEFAULT_APIKEY_MAP,
    tokenPricingMap: DEFAULT_TOKEN_PRICING_MAP,
    getApiKeyByType,
    getModelKeyByType,
    getModelUrlByType,
    getTokenPricingByType,
    setModel,
    setModelUrlByType,
    setModelKeyByType,
    setApiKeyByType,
    setTokenPricingByType,
    initializeModel,
  };
});

export default useModelStore;
