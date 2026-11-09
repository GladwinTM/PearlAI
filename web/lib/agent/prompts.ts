import "server-only";

import { type Clinic, fmtHour } from "./clinic";
import { dateContext } from "./clock";
import { PROMPTS } from "./prompts.generated";

// Versioned system prompts (port of agent/prompts.py; templates synced from the Python agent).

export function clinicBlock(c: Clinic): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const lines = ["Dentists (use these ids in tools):"];
  for (const d of c.dentists) {
    const hours = [...d.schedule.entries()]
      .sort((a, b) => (a[0] || 7) - (b[0] || 7))
      .map(([wd, h]) => `${days[wd]} ${fmtHour(h.start)}–${fmtHour(h.end)}`)
      .join(", ");
    const services = [...d.services].sort().join(", ");
    lines.push(`- ${d.fullName} (dentist_id "${d.key}"), ${d.specialty}. Does: ${services}. Hours: ${hours}.`);
  }
  lines.push(
    "Visit types: " + [...c.types.values()].map((t) => `${t.id} (${t.name}, ${t.durationMinutes} min)`).join("; ") + ".",
  );
  lines.push(
    `Lunch break ${fmtHour(c.lunch.start)}–${fmtHour(c.lunch.end)}. Closed on Sundays. ` +
      `New patients (no completed visit yet) can only start before ${fmtHour(c.newPatientCutoff)}.`,
  );
  return lines.join("\n");
}

export function render(version: string, clinic: Clinic, now: Date): string {
  const template = PROMPTS[version];
  if (!template) throw new Error(`Prompt version '${version}' not found. Available: ${Object.keys(PROMPTS).join(", ")}`);
  const block = clinicBlock(clinic);
  const dates = dateContext(now, clinic.tz, clinic.workingByWeekday(), clinic.closedDates());
  // Function replacements: no special handling of "$" in the inserted text.
  const text = template.replaceAll("{{clinic}}", () => block).replaceAll("{{dates}}", () => dates);
  return text.trim() + "\n";
}
