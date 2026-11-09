// Red-flag symptom detector: a deterministic backstop on every user message BEFORE the LLM (port of agent/safety.py).
// Deliberately over-inclusive: a false positive costs one escalation, a miss can cost much more.

const NEG = String.raw`(?<!no )(?<!not )(?<!without )(?<!don't have )(?<!dont have )(?<!no high )`;

const SWELLING = /\b(swell\w*|swollen|puff(y|ed|iness)|abscess)\b/i;
const FEVER = new RegExp(NEG + String.raw`\b(fever\w*|feverish|temperature|chills|shivering)\b`, "i");
const BREATH_SWALLOW =
  /\b(can'?t|cannot|can not|unable to|difficulty|difficult|trouble|hard to|struggling to|problem)\b[\w\s,]{0,20}?\b(breath\w*|swallow\w*)\b/i;
const SHORT_OF_BREATH = /\b(short(ness)? of breath|choking|throat (is )?closing)\b/i;
const BLEEDING = new RegExp(
  String.raw`\b(heavy|heavily|lots? of|a lot of|so much|non-?stop|uncontrolled|profuse\w*|keeps?|won'?t stop|wont stop|` +
    String.raw`can'?t stop|not stopping|pouring|gushing)\b[\w\s]{0,20}?\bbleed\w*\b` +
    String.raw`|\bbleed\w*\b[\w\s]{0,20}?\b(won'?t|wont|doesn'?t|does not|isn'?t|not) stop\w*\b` +
    String.raw`|\bbleed\w*\b[\w\s]{0,10}?\b(heavily|a lot|non-?stop)\b`,
  "i",
);
const TRAUMA = new RegExp(
  String.raw`\b(knocked[- ]out|knocked out|broken jaw|jaw (is )?broken|fractured jaw|dislocated jaw)\b` +
    String.raw`|\b(hit|fell|fall(en)?|accident|punched|crash\w*|injur\w*|trauma|blow)\b[\w\s,]{0,30}?\b(face|jaw|mouth|teeth|tooth|head)\b` +
    String.raw`|\b(face|jaw|mouth|teeth|tooth)\b[\w\s,]{0,30}?\b(hit|accident|injur\w*|trauma|smashed|cracked open)\b`,
  "i",
);
const SPREADING = /\bswell\w*\b[\w\s]{0,30}?\b(eye|neck|throat)\b|\b(eye|neck|throat)\b[\w\s]{0,15}?\bswell\w*/i;

export interface SafetyResult {
  triggered: boolean;
  rules: string[];
  breathingOrSwallowing: boolean;
  instruction: string;
}

export function checkMessage(text: string): SafetyResult {
  const t = text.split(/\s+/).filter(Boolean).join(" ");
  const rules: string[] = [];
  if (SWELLING.test(t) && FEVER.test(t)) rules.push("swelling_with_fever");
  const breath = BREATH_SWALLOW.test(t) || SHORT_OF_BREATH.test(t);
  if (breath) rules.push("breathing_or_swallowing");
  if (SPREADING.test(t)) rules.push("spreading_swelling");
  if (BLEEDING.test(t)) rules.push("heavy_bleeding");
  if (TRAUMA.test(t)) rules.push("facial_trauma");
  const triggered = rules.length > 0;
  const extra = breath
    ? " Breathing or swallowing is affected: tell them to go to the nearest hospital emergency department now."
    : " If breathing or swallowing becomes difficult, they must go to the nearest hospital emergency department.";
  const instruction = triggered
    ? `URGENT (safety rule triggered: ${rules.join(", ")}): follow the emergency protocol. ` +
      "Do not diagnose and do not suggest any medicine. Say calmly that this may be serious. " +
      "Call escalate_to_human with urgency='urgent' now, then tell the patient a staff member will call them shortly." +
      extra
    : "";
  return { triggered, rules, breathingOrSwallowing: breath, instruction };
}
