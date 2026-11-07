"use client";

import { useCallback, useSyncExternalStore } from "react";

import { PERSONAS } from "./personas";

const KEY = "smiledesk.persona";
const listeners = new Set<() => void>();

function read(): string {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v && PERSONAS.some((p) => p.id === v)) return v;
  } catch {
    /* storage blocked: fall back to the default */
  }
  return PERSONAS[0].id;
}

/** The "who am I" choice, remembered across pages (landing → /talk) in localStorage. */
export function usePersona(): [string, (id: string) => void] {
  const persona = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      window.addEventListener("storage", cb);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", cb);
      };
    },
    read,
    () => PERSONAS[0].id,
  );
  const set = useCallback((id: string) => {
    try {
      window.localStorage.setItem(KEY, id);
    } catch {
      /* ignore */
    }
    listeners.forEach((l) => l());
  }, []);
  return [persona, set];
}
