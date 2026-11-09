import Link from "next/link";

import { ToothMark } from "@/components/pearl/tooth-mark";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="on-sky studs grid flex-1 place-items-center bg-sky px-4 py-24 text-center text-deep">
      <div className="max-w-xl">
        <div className="relative mx-auto w-fit">
          <ToothMark face="confused" className="h-36 w-auto -rotate-6 drop-shadow-[0_6px_0_var(--edge)]" />
          <span aria-hidden className="absolute -top-2 -right-8 font-display text-5xl font-bold text-deep">
            ?
          </span>
        </div>
        <p className="mt-6 font-display text-7xl leading-none font-bold text-brick sm:text-8xl">404</p>
        <h1 className="mt-2 font-display text-3xl leading-tight font-bold uppercase sm:text-4xl">This page has gone for a cleaning</h1>
        <p className="mt-3 font-medium">We couldn&apos;t find what you were looking for. Pearl can still help you book a checkup, though.</p>
        <div className="mt-7 flex justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/talk?mode=voice">Talk to Pearl</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/">Home</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
