import Link from "next/link";

import { BootGate } from "@/components/boot/boot-gate";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { LocalBadges } from "@/components/landing/local-badges";
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
        <Button asChild size="sm" className="rounded-full">
          <Link href="/talk">Try it</Link>
        </Button>
      </SiteHeader>
      <main className="flex-1 bg-pearl-glow">
        <Hero />
        <HowItWorks />
        <LocalBadges />
      </main>
      <footer className="border-t py-6 text-center text-sm text-muted-foreground">
        SmileDesk is a portfolio demo. Pearl Dental Care, its dentists and patients are fictional.
      </footer>
    </BootGate>
  );
}
