"use client";

import { useEffect } from "react";

const DEFAULT_BLOCKED_KEYS = [
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
];

const defaultIgnoreTarget = (target: EventTarget | null) => {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
};

interface UsePreventScrollOptions {
  enabled?: boolean;
  blockedKeys?: string[];
  ignoreTarget?: (target: EventTarget | null) => boolean;
  preventWheel?: boolean;
  preventTouchMove?: boolean;
  preventKeyboard?: boolean;
  onKeyDown?: (event: KeyboardEvent) => void;
}

export function usePreventScroll({
  enabled = true,
  blockedKeys = DEFAULT_BLOCKED_KEYS,
  ignoreTarget = defaultIgnoreTarget,
  preventWheel = true,
  preventTouchMove = true,
  preventKeyboard = true,
  onKeyDown,
}: UsePreventScrollOptions = {}) {
  useEffect(() => {
    if (!enabled) return;

    const preventScroll = (event: Event) => {
      if (event.cancelable) {
        event.preventDefault();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      onKeyDown?.(event);
      if (ignoreTarget(event.target)) return;
      if (blockedKeys.includes(event.key)) {
        event.preventDefault();
      }
    };

    if (preventKeyboard) {
      window.addEventListener("keydown", handleKeyDown, { passive: false });
    }
    if (preventWheel) {
      window.addEventListener("wheel", preventScroll, { passive: false });
    }
    if (preventTouchMove) {
      window.addEventListener("touchmove", preventScroll, { passive: false });
    }

    return () => {
      if (preventKeyboard) {
        window.removeEventListener("keydown", handleKeyDown);
      }
      if (preventWheel) {
        window.removeEventListener("wheel", preventScroll);
      }
      if (preventTouchMove) {
        window.removeEventListener("touchmove", preventScroll);
      }
    };
  }, [
    enabled,
    blockedKeys,
    ignoreTarget,
    preventKeyboard,
    preventWheel,
    preventTouchMove,
    onKeyDown,
  ]);
}
