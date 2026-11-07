"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";

const NEXT = { system: "light", light: "dark", dark: "system" } as const;
const ICON = { system: Monitor, light: Sun, dark: Moon } as const;

/** Cycles system → light → dark. Renders a neutral icon until mounted (the theme is only known client-side). */
export function ThemeToggle() {
  const { theme = "system", setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const current = (mounted ? theme : "system") as keyof typeof NEXT;
  const Icon = ICON[current] ?? Monitor;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(NEXT[current] ?? "system")}
      aria-label={`Theme: ${current}. Switch to ${NEXT[current] ?? "system"}`}
      title={`Theme: ${current}`}
    >
      <Icon />
    </Button>
  );
}
