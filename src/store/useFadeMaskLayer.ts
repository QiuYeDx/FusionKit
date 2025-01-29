import { create } from "zustand";

interface FadeMaskLayerStore {
  cx: number; // 圆心的 x 坐标
  cy: number; // 圆心的 y 坐标
  rectWidth: number; // 矩形可视区域宽度
  rectHeight: number; // 矩形可视区域长度
  showMaskLayer: boolean; // 是否显示遮罩层内容, 默认为 false
  showInner: boolean; // 控制 Layer 自身显示圆形内部还是外部的部分, 默认为 true
  // 保存遮罩层背景图片数据
  backgroundImage: string | null; // 遮罩层背景图片
  visible: boolean; // 遮罩层是否可见
  setVisible: (flag: boolean) => void; // 设置 visible
  setShowInner: (showInner: boolean) => void; // 设置 showInner
  setCenterXY: (x: number, y: number) => void; // 设置 cx 和 cy
  setRectSize: (w: number, h: number) => void; // 设置 rectWidth 和 rectHeight
  setShowMaskLayer: (flag: boolean) => void; // 设置 showMaskLayer
  // 修改遮罩层背景图片数据的方法
  setBackgroundImage: (imageUrl: string) => void; // 设置遮罩层背景图片
  getTargetRadius: () => number; // 计算目标半径（getter）
}

const useFadeMaskLayerStore = create<FadeMaskLayerStore>((set, get) => {
  const setVisible = (flag: boolean) => {
    set({ visible: flag });
  };

  const setShowInner = (showInner: boolean) => {
    set({
      showInner,
    });
  };

  const setCenterXY = (x: number, y: number) => {
    set({
      cx: x,
      cy: y,
    });
  };

  const setShowMaskLayer = (flag: boolean) => {
    set({
      showMaskLayer: flag,
    });
  };

  const setBackgroundImage = (imageUrl: string) => {
    set({
      backgroundImage: imageUrl,
    });
  };

  const setRectSize = (w: number, h: number) => {
    set({
      rectWidth: w,
      rectHeight: h,
    });
  };

  const getTargetRadius = () => {
    const { cx, cy, rectWidth, rectHeight } = get();

    // 计算到四个顶点的距离
    const distanceToTopLeft = Math.sqrt(cx ** 2 + cy ** 2); // 左上角 (0, 0)
    const distanceToTopRight = Math.sqrt((rectWidth - cx) ** 2 + cy ** 2); // 右上角 (rectWidth, 0)
    const distanceToBottomLeft = Math.sqrt(cx ** 2 + (rectHeight - cy) ** 2); // 左下角 (0, rectHeight)
    const distanceToBottomRight = Math.sqrt(
      (rectWidth - cx) ** 2 + (rectHeight - cy) ** 2
    ); // 右下角 (rectWidth, rectHeight)

    // 返回最大距离作为目标半径
    return Math.max(
      distanceToTopLeft,
      distanceToTopRight,
      distanceToBottomLeft,
      distanceToBottomRight
    );
  };

  return {
    cx: 0,
    cy: 0,
    rectWidth: 0,
    rectHeight: 0,
    showMaskLayer: false,
    showInner: true,
    backgroundImage: null,
    visible: false,
    setVisible,
    setShowInner,
    setCenterXY,
    setRectSize,
    setShowMaskLayer,
    setBackgroundImage,
    getTargetRadius, // 目标 targetR 的值, 通过 rectWidth, rectHeight, cx, cy 计算出来
  };
});

export default useFadeMaskLayerStore;
