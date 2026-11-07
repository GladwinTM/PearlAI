"use client";

import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from "react";

import { getHealth, type Health } from "@/lib/api";

interface HealthState {
  health: Health | null;
  unreachable: boolean;
}

const Ctx = createContext<HealthState>({ health: null, unreachable: false });

/** Polls /api/health: every second while warming or unreachable, every 15 s once everything is ready. */
export function HealthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HealthState>({ health: null, unreachable: false });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const ctrl = new AbortController();
    const tick = async () => {
      try {
        const h = await getHealth(ctrl.signal);
        if (stopped) return;
        setState({ health: h, unreachable: false });
        timer = setTimeout(tick, h.status === "ok" ? 15000 : 1000);
      } catch {
        if (stopped) return;
        setState((s) => ({ ...s, unreachable: true }));
        timer = setTimeout(tick, 1500);
      }
    };
    void tick();
    return () => {
      stopped = true;
      ctrl.abort();
      clearTimeout(timer);
    };
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

const EMPTY: HealthState = { health: null, unreachable: false };
const noop = () => () => {};

/**
 * Health for components. Returns the server value (nothing yet) until this component has hydrated: a Suspense
 * boundary can hydrate after the first poll landed, and rendering fresh data then would mismatch the server HTML.
 */
export function useHealth(): HealthState {
  const value = useContext(Ctx);
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  return hydrated ? value : EMPTY;
}
