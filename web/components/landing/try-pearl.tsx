"use client";

import { useRouter } from "next/navigation";

import { PersonaSwitcher } from "@/components/talk/persona-switcher";
import { TryChips } from "@/components/talk/try-chips";
import { usePersona } from "@/lib/use-persona";

/** "Who's calling?" persona cards + "things to try" prompts. */
export function TryPearl() {
  const [persona, setPersona] = usePersona();
  const router = useRouter();
  return (
    <section aria-labelledby="who-title" className="mx-auto w-full max-w-6xl px-4 py-16 sm:py-20">
      <div className="max-w-2xl">
        <p className="text-sm font-medium text-primary">Try the demo</p>
        <h2 id="who-title" className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">
          Who&apos;s calling?
        </h2>
        <p className="mt-3 text-muted-foreground">
          Each persona comes with a caller ID, the way a real clinic phone line would, so Pearl knows who&apos;s calling and you
          never type a phone number.
        </p>
      </div>
      <PersonaSwitcher value={persona} onChange={setPersona} cards className="mt-8" />
      <TryChips
        prominent
        label="Things to try (opens a chat)"
        className="mt-10"
        onPick={(p) => router.push(`/talk?mode=chat&prompt=${encodeURIComponent(p)}`)}
      />
    </section>
  );
}
