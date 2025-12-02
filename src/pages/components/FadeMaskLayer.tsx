import useFadeMaskLayerStore from "@/store/useFadeMaskLayer";
import useThemeStore from "@/store/useThemeStore";
import { useSpringValue } from "@react-spring/web";
import { useEffect, useState } from "react";
import { useWindowSize } from "@reactuses/core";

function FadeMaskLayer() {
  const { width, height } = useWindowSize();
  const {
    cx,
    cy,
    rectWidth,
    rectHeight,
    showMaskLayer,
    showInner,
    backgroundImage,
    visible,
    setVisible,
    getTargetRadius,
  } = useFadeMaskLayerStore();
  const { isDark } = useThemeStore();
  const [r, setR] = useState(0);

  const rSpring = useSpringValue(
    isDark ? Math.sqrt(width ** 2 + height ** 2) : 0,
    {
      config: {
        // duration: 3000, // for debug
      },
      onChange(val: any) {
        setR(val);
      },
      onRest() {
        setVisible(false);
      },
    }
  );

  useEffect(() => {
    const targetR = getTargetRadius();
    if (rSpring) {
      rSpring.start(isDark ? targetR : 0);
    }

    // 重置页面滚动到顶部
    // 找到 ScrollArea 内部的实际滚动容器
    const scrollViewport = document.querySelector(
      "[data-radix-scroll-area-viewport]"
    );
    if (scrollViewport) {
      scrollViewport.scrollTo({
        top: 0,
        behavior: "instant" as ScrollBehavior,
      });
    }
  }, [showMaskLayer, getTargetRadius()]);

  // * 业务方的触发方法(使用示例)
  // const handleTestClick = (e: MouseEvent<HTMLDivElement>) => {
  //   setShowInner(false); // 根据需要进行选择
  //   setRectSize(width, height);
  //   setCenterXY(e.clientX, e.clientY);
  //   setShowMaskLayer(!showMaskLayer);
  // };

  return !visible ? (
    <div className="hidden"></div>
  ) : showInner ? (
    <div
      className={`fade-mask-layer fixed inset-0 h-full w-full bg-cover bg-center pointer-events-none z-50`}
      style={{
        maskImage: `url(
          "data:image/svg+xml,%3csvg width='${rectWidth}' height='${rectHeight}' xmlns='http://www.w3.org/2000/svg'%3e%3ccircle fill='black' cx='${cx}' cy='${cy}' r='${r}' fill-rule='evenodd'/%3e%3c/svg%3e"
        )`,
        backgroundImage: backgroundImage ? `url(${backgroundImage})` : "none",
        // ...(backgroundImage
        //   ? { backgroundImage: `url(${backgroundImage})` }
        //   : {}),
      }}
    ></div>
  ) : (
    <div
      className="fade-mask-layer fade-mask-layer-inner fixed inset-0 h-full w-full bg-cover bg-center pointer-events-none z-50"
      style={{
        maskImage: `url("data:image/svg+xml,%3csvg width='${rectWidth}' height='${rectHeight}' xmlns='http://www.w3.org/2000/svg'%3e%3cmask id='mask'%3e%3crect width='100%25' height='100%25' fill='white'/%3e%3ccircle cx='${cx}' cy='${cy}' r='${r}' fill='black'/%3e%3c/mask%3e%3crect width='100%25' height='100%25' fill='white' mask='url(%23mask)'/%3e%3c/svg%3e")`,
        backgroundImage: backgroundImage ? `url(${backgroundImage})` : "none",
      }}
    ></div>
  );
}

export default FadeMaskLayer;
