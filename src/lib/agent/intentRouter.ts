export type AgentIntent =
  | "task_complete"
  | "task_create"
  | "task_list_open"
  | "task_find"
  | "unknown";

export interface IntentDecision {
  intent: AgentIntent;
  confidence: number;
  autonomousAllowed: boolean;
  extractedTaskText?: string;
}

const TASK_COMPLETE_PATTERNS: RegExp[] = [
  /\b(закры(ть|й|ваем|л[аи]?|то)|выполн(ить|и|ена|ено|ить задачу)|отмет(ить|ь) (как )?выполн)\b/i,
  /\b(close|complete|finish|mark (it )?done|done)\b/i,
];
const TASK_CREATE_PATTERNS: RegExp[] = [
  /\b(созда(й|ть|й задачу)|добав(ь|ить) задач|нов(ая|ую) задач|запиши задачу)\b/i,
  /\b(create|add) (a )?task\b/i,
];
const TASK_LIST_PATTERNS: RegExp[] = [
  /\b(какие .*задач|покажи .*задач|список .*задач|открыт(ые|ых) задач|незакрыт(ые|ых) задач)\b/i,
  /\b(list|show) (open )?tasks?\b/i,
];
const TASK_FIND_PATTERNS: RegExp[] = [
  /\b(найд(и|и мне|ите)|поищ(и|и мне)|где .*задач)\b/i,
  /\b(find|search|look up)\b.*\btask\b/i,
];

const AUTONOMY_PATTERNS: RegExp[] = [
  /\b(любу(ю|й)|без меня|не спрашивая|самостоятельно|сам выбери|выбери сам)\b/i,
  /\b(any( one)?|without asking|autonomously|pick any|choose any)\b/i,
];

const GENERIC_TASK_PATTERNS: RegExp[] = [
  /\b(задач[ауые]|task[s]?)\b/gi,
  /\b(незакрыт[а-я]*|open)\b/gi,
];

export function detectIntent(userText: string): IntentDecision {
  const text = userText.trim();
  if (!text) {
    return { intent: "unknown", confidence: 0, autonomousAllowed: false };
  }

  const hasCompleteSignal = TASK_COMPLETE_PATTERNS.some((re) => re.test(text));
  const hasCreateSignal = TASK_CREATE_PATTERNS.some((re) => re.test(text));
  const hasListSignal = TASK_LIST_PATTERNS.some((re) => re.test(text));
  const hasFindSignal = TASK_FIND_PATTERNS.some((re) => re.test(text));
  const hasAutonomySignal = AUTONOMY_PATTERNS.some((re) => re.test(text));
  const hasTaskSignal = /\b(задач|task)\b/i.test(text);

  if (hasCreateSignal) {
    let confidence = 0.72;
    if (hasTaskSignal) confidence += 0.15;
    const extractedTaskText = extractCreateTaskText(text);
    if (extractedTaskText) confidence += 0.1;
    if (confidence > 0.95) confidence = 0.95;
    return {
      intent: "task_create",
      confidence,
      autonomousAllowed: hasAutonomySignal,
      extractedTaskText,
    };
  }

  if (hasListSignal) {
    let confidence = 0.78;
    if (hasTaskSignal) confidence += 0.12;
    if (confidence > 0.95) confidence = 0.95;
    return {
      intent: "task_list_open",
      confidence,
      autonomousAllowed: hasAutonomySignal,
    };
  }

  if (hasFindSignal && hasTaskSignal) {
    let confidence = 0.73;
    const extractedTaskText = extractTaskNeedle(text);
    if (extractedTaskText) confidence += 0.1;
    if (confidence > 0.95) confidence = 0.95;
    return {
      intent: "task_find",
      confidence,
      autonomousAllowed: hasAutonomySignal,
      extractedTaskText,
    };
  }

  if (!hasCompleteSignal) {
    return {
      intent: "unknown",
      confidence: hasTaskSignal ? 0.35 : 0.1,
      autonomousAllowed: hasAutonomySignal,
    };
  }

  let confidence = 0.75;
  if (hasTaskSignal) confidence += 0.15;
  if (hasAutonomySignal) confidence += 0.05;
  if (confidence > 0.95) confidence = 0.95;

  return {
    intent: "task_complete",
    confidence,
    autonomousAllowed: hasAutonomySignal,
    extractedTaskText: extractTaskNeedle(text),
  };
}

function extractTaskNeedle(text: string): string | undefined {
  let candidate = text;
  const cleanerPatterns: RegExp[] = [
    /\b(пожалуйста|please)\b/gi,
    /\b(закры(ть|й|ваем|л[аи]?|то)|выполн(ить|и)|complete|close|finish|mark (it )?done)\b/gi,
    /\b(задач[ауые]|task[s]?)\b/gi,
    /\b(любую|любой|any( one)?|самостоятельно|без меня|не спрашивая|autonomously|without asking|pick any|choose any)\b/gi,
  ];
  for (const re of cleanerPatterns) {
    candidate = candidate.replace(re, " ");
  }
  candidate = candidate.replace(/[.,!?;:()[\]{}"']/g, " ");
  candidate = candidate.replace(/\s+/g, " ").trim();
  if (!candidate) return undefined;

  const genericHits = GENERIC_TASK_PATTERNS.reduce((acc, re) => {
    const matches = candidate.match(re);
    return acc + (matches?.length ?? 0);
  }, 0);
  if (genericHits > 0 && candidate.split(/\s+/).length <= 3) {
    return undefined;
  }
  return candidate;
}

function extractCreateTaskText(text: string): string | undefined {
  let candidate = text;
  const cleanerPatterns: RegExp[] = [
    /\b(пожалуйста|please)\b/gi,
    /\b(созда(й|ть)|добав(ь|ить)|запиши|нов(ая|ую)|create|add)\b/gi,
    /\b(задач[ауые]|task[s]?)\b/gi,
    /\b(мне|для меня|please)\b/gi,
  ];
  for (const re of cleanerPatterns) {
    candidate = candidate.replace(re, " ");
  }
  candidate = candidate.replace(/[.,!?;:()[\]{}"']/g, " ");
  candidate = candidate.replace(/\s+/g, " ").trim();
  if (!candidate) return undefined;
  if (candidate.split(/\s+/).length < 2) return undefined;
  return candidate;
}
