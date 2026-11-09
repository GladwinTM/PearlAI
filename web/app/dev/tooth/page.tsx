import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ToothLab } from "@/components/pearl/tooth-lab";

export const metadata: Metadata = { title: "Tooth lab", robots: { index: false } };

/** Review page for Pearl's 3D tooth: every state and expression. Development only. */
export default function ToothLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ToothLab />;
}
