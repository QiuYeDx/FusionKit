import useFadeMaskLayerStore from "@/store/useFadeMaskLayer";
import { useSpringValue } from "@react-spring/web";
import { MouseEvent, useEffect, useState } from "react";
import { useWindowSize } from "react-use";

function FadeMaskLayer() {
  const { width, height } = useWindowSize();
  const {
    cx,
    cy,
    rectWidth,
    rectHeight,
    showMaskLayer,
    setCenterXY,
    setRectSize,
    setShowMaskLayer,
    getTargetRadius,
  } = useFadeMaskLayerStore();
  const [r, setR] = useState(0);
  // const requestAnimationFrameIDRef = useRef(-1);

  const rSpring = useSpringValue(0, {
    onChange(val: any) {
      setR(val);
      // 暂时看起来不需要
      // requestAnimationFrameIDRef.current = requestAnimationFrame(() => {
      //   setR(val);
      //   requestAnimationFrameIDRef.current = -1;
      // });
    },
  });

  useEffect(() => {
    const targetR = getTargetRadius();
    if (rSpring) {
      rSpring.start(showMaskLayer ? targetR : 0);
    }
  }, [showMaskLayer, getTargetRadius()]);

  // * 业务方的触发方法
  const handleTestClick = (e: MouseEvent<HTMLDivElement>) => {
    setRectSize(width, height);
    setCenterXY(e.clientX, e.clientY);
    setShowMaskLayer(!showMaskLayer);
  };

  // pointer-events-none
  return (
    <div
      className={`fixed inset-0 h-full w-full bg-blue-300 bg-opacity-40 mask`}
      style={{
        maskImage: `url(
          "data:image/svg+xml,%3csvg width='${rectWidth}' height='${rectHeight}' xmlns='http://www.w3.org/2000/svg'%3e%3ccircle fill='black' cx='${cx}' cy='${cy}' r='${r}' fill-rule='evenodd'/%3e%3c/svg%3e"
        )`,
      }}
      onClick={handleTestClick}
    ></div>
  );
}

export default FadeMaskLayer;
