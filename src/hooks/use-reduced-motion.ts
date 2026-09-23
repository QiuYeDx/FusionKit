import { useSyncExternalStore } from 'react';

const query = '(prefers-reduced-motion: reduce)';
const getSnapshot = () => window.matchMedia(query).matches;
const getServerSnapshot = () => false;
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};

/** Read the current preference, including changes while a dialog is mounted. */
export function useReducedMotionPreference() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
