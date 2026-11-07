import type { Metadata } from "next";
import { Suspense } from "react";

import { BootGate } from "@/components/boot/boot-gate";
import { TalkApp } from "@/components/talk/talk-app";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Talk to Pearl" };

function TalkSkeleton() {
  return (
    <div className="grid h-dvh gap-4 p-4 lg:grid-cols-[340px_1fr_400px]" aria-busy="true" aria-label="Loading">
      <Skeleton className="hidden rounded-2xl lg:block" />
      <Skeleton className="rounded-2xl" />
      <Skeleton className="hidden rounded-2xl lg:block" />
    </div>
  );
}

export default function TalkPage() {
  return (
    <BootGate>
      {/* useSearchParams (mode, persona, prompt) needs a Suspense boundary to prerender the shell. */}
      <Suspense fallback={<TalkSkeleton />}>
        <TalkApp />
      </Suspense>
    </BootGate>
  );
}
