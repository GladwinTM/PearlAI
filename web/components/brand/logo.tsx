import { ToothMark } from "@/components/pearl/tooth-mark";
import { cn } from "@/lib/utils";

/** Pearl's static tooth on a blue tile: the logo mark. Same artwork as app/icon.svg. */
export function PearlMark({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-lg bg-primary shadow-sm", className)}>
      <ToothMark className="h-[70%] w-auto" />
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <PearlMark />
      <span className="flex flex-col leading-none">
        <span className="font-semibold tracking-tight">SmileDesk</span>
        <span className="mt-0.5 text-[0.7rem] text-muted-foreground">Pearl Dental Care</span>
      </span>
    </span>
  );
}
