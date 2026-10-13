import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// `rounded-smooth-*` (src/smooth-corners.css) sets the same corners as `rounded-*`,
// so a caller's `rounded-none` must replace a component's `rounded-smooth-xl` and vice versa.
const twMerge = extendTailwindMerge<"rounded-smooth">({
  extend: {
    classGroups: {
      "rounded-smooth": [{ "rounded-smooth": [() => true] }],
    },
    conflictingClassGroups: {
      rounded: ["rounded-smooth"],
      "rounded-smooth": ["rounded"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
