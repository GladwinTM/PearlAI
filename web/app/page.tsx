import Link from "next/link";

import { HealthPanel } from "@/components/health-panel";

// M1 placeholder: proves web → agent API → providers end to end. The real landing page arrives in M4.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-start gap-6 px-4 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">SmileDesk</h1>
      <p className="text-lg text-slate-600 dark:text-slate-300">
        AI front desk for Pearl Dental Care. Foundations build: service status.
      </p>
      <HealthPanel />
      <Link href="/chat" className="rounded bg-teal-700 px-4 py-2 font-medium text-white">
        Chat with Pearl →
      </Link>
    </main>
  );
}
