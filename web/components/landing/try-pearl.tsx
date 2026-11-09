"use client";

import { motion } from "motion/react";
import { useRouter } from "next/navigation";

import { PersonaSwitcher } from "@/components/talk/persona-switcher";
import { TryChips } from "@/components/talk/try-chips";
import { usePersona } from "@/lib/use-persona";

/** "Who's calling?" persona cards + "things to try" stickers. */
export function TryPearl() {
  const [persona, setPersona] = usePersona();
  const router = useRouter();
  return (
    <section aria-labelledby="who-title" className="mx-auto w-full max-w-6xl px-4 py-16 sm:py-24">
      <motion.h2
        id="who-title"
        className="text-center font-display text-5xl leading-[0.9] font-bold uppercase sm:text-7xl"
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ type: "spring", stiffness: 300, damping: 24 }}
      >
        Who&apos;s calling?
      </motion.h2>
      <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">
        Pick who you are: each one comes with a caller ID, so Pearl already knows the number and you never type it.
      </p>
      <PersonaSwitcher value={persona} onChange={setPersona} cards className="mt-10" />
      <TryChips
        stickers
        label="Things to try (opens a chat)"
        className="mt-14"
        onPick={(p) => router.push(`/talk?mode=chat&prompt=${encodeURIComponent(p)}`)}
      />
    </section>
  );
}
