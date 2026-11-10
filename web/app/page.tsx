import Link from "next/link";

import { BootGate } from "@/components/boot/boot-gate";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { LocalBadges } from "@/components/landing/local-badges";
import { TryPearl } from "@/components/landing/try-pearl";
import { ToothMark } from "@/components/pearl/tooth-mark";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { GITHUB_URL } from "@/lib/config";

export default function Home() {
  return (
    <BootGate>
      <SiteHeader>
        <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
          <a href="#how">How it works</a>
        </Button>
        {GITHUB_URL && (
          <Button asChild variant="ghost" size="sm">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </Button>
        )}
        <Button asChild size="sm">
          <Link href="/talk?mode=voice">Try it</Link>
        </Button>
      </SiteHeader>
      <main className="flex-1">
        <Hero />
        <TryPearl />
        <HowItWorks />
        <LocalBadges />
      </main>
      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        <ToothMark className="mx-auto mb-2 h-8 w-auto" />
        SmileDesk is a portfolio demo. Pearl Dental Care, its dentists and patients are fictional.
      </footer>
    </BootGate>
  );
}
