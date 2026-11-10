import Link from "next/link";

import { ToothMark } from "@/components/pearl/tooth-mark";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="grid flex-1 place-items-center px-4 py-24 text-center">
      <div className="max-w-md">
        <div className="stage mx-auto grid size-24 place-items-center rounded-2xl border">
          <ToothMark face="confused" className="h-14 w-auto" />
        </div>
        <p className="mt-6 text-sm font-medium text-primary">404</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">This page has gone for a cleaning</h1>
        <p className="mt-3 text-muted-foreground">We couldn&apos;t find what you were looking for. Pearl can still help you book a checkup, though.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button asChild>
            <Link href="/talk?mode=voice">Talk to Pearl</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Home</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
