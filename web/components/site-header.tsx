import Link from "next/link";
import type { ReactNode } from "react";

import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

export function SiteHeader({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <header className={cn("sticky top-0 z-30 border-b-2 border-edge-soft bg-background/85 backdrop-blur", className)}>
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-4">
        <Link href="/" className="rounded-xl">
          <Logo />
        </Link>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          {children}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
