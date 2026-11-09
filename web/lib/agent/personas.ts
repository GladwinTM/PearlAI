import "server-only";

// Recruiter-mode personas: caller ID pre-filled so nobody types a phone number (mirrors agent/personas.py; the
// browser-safe list without phone numbers lives in lib/personas.ts).
export const PERSONA_PHONES: Record<string, string | null> = {
  ravi: "+919800000001",
  anjali: "+919800000002",
  ravi_meena: "+919800000001",
  new: null,
};

export const callerPhoneFor = (persona: string | null | undefined) => (persona ? (PERSONA_PHONES[persona] ?? null) : null);
