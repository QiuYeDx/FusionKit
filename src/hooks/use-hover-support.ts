import { useState, useEffect } from "react";

/**
 * 检测当前设备的主要输入方式是否支持 hover。
 * 在触屏移动端设备上返回 false，桌面端（鼠标/触控板）返回 true。
 * SSR 安全：服务端渲染时默认返回 false，挂载后根据实际能力更新。
 */
export function useHoverSupport(): boolean {
  const [canHover, setCanHover] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(hover: hover)");
    const onChange = () => setCanHover(mql.matches);

    setCanHover(mql.matches);
    mql.addEventListener("change", onChange);

    return () => mql.removeEventListener("change", onChange);
  }, []);

  return canHover;
}
