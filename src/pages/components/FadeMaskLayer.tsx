import useFadeMaskLayerStore from "@/store/useFadeMaskLayer";
import { useMotionValue, animate as motionAnimate } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

function FadeMaskLayer() {
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
  } = useFadeMaskLayerStore();
  const [r, setR] = useState(0);

  const rMotionValue = useMotionValue(0);
  const animationRef = useRef<ReturnType<typeof motionAnimate> | null>(null);

  const { maskWidth, maskHeight, targetR } = useMemo(() => {
    const width =
      rectWidth ||
      (typeof window !== "undefined"
        ? window.innerWidth || document.documentElement.clientWidth
        : 0);
    const height =
      rectHeight ||
      (typeof window !== "undefined"
        ? window.innerHeight || document.documentElement.clientHeight
        : 0);

    const radius = Math.max(
      Math.hypot(cx, cy),
      Math.hypot(width - cx, cy),
      Math.hypot(cx, height - cy),
      Math.hypot(width - cx, height - cy)
    );

    return { maskWidth: width, maskHeight: height, targetR: radius };
  }, [cx, cy, rectHeight, rectWidth]);

  useEffect(() => {
    return rMotionValue.on("change", (val) => setR(val));
  }, [rMotionValue]);

  useLayoutEffect(() => {
    if (!visible) return;

    animationRef.current?.stop();
    const startR = showInner ? targetR : 0;
    const endR = showInner ? 0 : targetR;

    rMotionValue.set(startR);
    setR(startR);
    animationRef.current = motionAnimate(
      rMotionValue,
      endR,
      {
        type: "spring",
        bounce: 0,
        onComplete: () => setVisible(false),
      }
    );

    const scrollViewport = document.querySelector(
      "[data-radix-scroll-area-viewport]"
    );
    if (scrollViewport) {
      scrollViewport.scrollTo({
        top: 0,
        behavior: "instant" as ScrollBehavior,
      });
    }
  }, [rMotionValue, setVisible, showInner, showMaskLayer, targetR, visible]);

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
          "data:image/svg+xml,%3csvg width='${maskWidth}' height='${maskHeight}' xmlns='http://www.w3.org/2000/svg'%3e%3ccircle fill='black' cx='${cx}' cy='${cy}' r='${r}' fill-rule='evenodd'/%3e%3c/svg%3e"
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
        maskImage: `url("data:image/svg+xml,%3csvg width='${maskWidth}' height='${maskHeight}' xmlns='http://www.w3.org/2000/svg'%3e%3cmask id='mask'%3e%3crect width='100%25' height='100%25' fill='white'/%3e%3ccircle cx='${cx}' cy='${cy}' r='${r}' fill='black'/%3e%3c/mask%3e%3crect width='100%25' height='100%25' fill='white' mask='url(%23mask)'/%3e%3c/svg%3e")`,
        backgroundImage: backgroundImage ? `url(${backgroundImage})` : "none",
      }}
    ></div>
  );
}

export default FadeMaskLayer;
