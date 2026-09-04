export const TEMPORAL_RESOLVER_VERSION = 3;

export type TemporalAnnotation = {
  phrase: string;
  start: number;
  end: number;
  rangeStart: string;
  rangeEnd: string;
  referenceTimestamp: string;
  timeZone: string;
  resolverVersion: number;
  confidence: number;
};

type CalendarDate = { year: number; month: number; day: number };

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MONTH_INDEX: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const QUANTITY: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const MONTH_TOKEN = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const QUANTITY_TOKEN = String.raw`(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;

const TEMPORAL_PHRASE = new RegExp(
  String.raw`\b(?:day\s+after\s+tomorrow|day\s+before\s+yesterday|in\s+${QUANTITY_TOKEN}\s+(?:days?|weeks?|months?|years?)|${QUANTITY_TOKEN}\s+(?:days?|weeks?|months?|years?)\s+ago|\d{4}-\d{2}-\d{2}|${MONTH_TOKEN}\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|${MONTH_TOKEN}\s+\d{4}|today|tomorrow|yesterday|(?:last|this|next)\s+(?:weekend|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b`,
  "giu",
);

export function resolveTemporalExpressions(
  text: string,
  options: { referenceTimestamp: string; timeZone: string },
): TemporalAnnotation[] {
  const reference = new Date(options.referenceTimestamp);
  if (Number.isNaN(reference.valueOf())) return [];
  const localReference = localCalendarDate(reference, options.timeZone);
  const annotations: TemporalAnnotation[] = [];
  for (const match of text.matchAll(TEMPORAL_PHRASE)) {
    const phrase = match[0];
    const range = resolvePhrase(phrase.toLocaleLowerCase("en-US"), localReference);
    if (!range) continue;
    annotations.push({
      phrase,
      start: match.index,
      end: match.index + phrase.length,
      rangeStart: zonedStartOfDay(range.start, options.timeZone),
      rangeEnd: zonedStartOfDay(range.end, options.timeZone),
      referenceTimestamp: reference.toISOString(),
      timeZone: options.timeZone,
      resolverVersion: TEMPORAL_RESOLVER_VERSION,
      confidence: 1,
    });
  }
  return annotations;
}

export function temporalEmbeddingContext(
  annotations: readonly TemporalAnnotation[],
): string {
  if (annotations.length === 0) return "";
  const resolved = annotations
    .map(
      (annotation) =>
        `"${annotation.phrase}" means ${annotation.rangeStart} through ${annotation.rangeEnd} ` +
        `in ${annotation.timeZone}`,
    )
    .join("; ");
  return `\n\n[Afternote resolved time: ${resolved}]`;
}

function resolvePhrase(
  phrase: string,
  reference: CalendarDate,
): { start: CalendarDate; end: CalendarDate } | null {
  if (phrase === "day after tomorrow") return oneDay(addDays(reference, 2));
  if (phrase === "day before yesterday") return oneDay(addDays(reference, -2));
  const relativeOffset = resolveRelativeOffset(phrase, reference);
  if (relativeOffset) return relativeOffset;
  const namedMonth = resolveNamedMonth(phrase);
  if (namedMonth) return namedMonth;
  const explicitDate = resolveExplicitDate(phrase, reference.year);
  if (explicitDate) return oneDay(explicitDate);
  if (phrase === "today") return oneDay(reference);
  if (phrase === "tomorrow") return oneDay(addDays(reference, 1));
  if (phrase === "yesterday") return oneDay(addDays(reference, -1));

  const [direction, unit] = phrase.split(/\s+/u);
  const offset = direction === "last" ? -1 : direction === "next" ? 1 : 0;
  if (unit === "weekend") {
    const monday = addDays(reference, -((dayOfWeek(reference) + 6) % 7));
    const start = addDays(monday, 5 + offset * 7);
    return { start, end: addDays(start, 2) };
  }
  if (unit === "week") {
    const monday = addDays(reference, -((dayOfWeek(reference) + 6) % 7));
    const start = addDays(monday, offset * 7);
    return { start, end: addDays(start, 7) };
  }
  if (unit === "month") {
    const start = addMonths({ ...reference, day: 1 }, offset);
    return { start, end: addMonths(start, 1) };
  }
  if (unit === "year") {
    const start = { year: reference.year + offset, month: 1, day: 1 };
    return { start, end: { year: start.year + 1, month: 1, day: 1 } };
  }
  const weekday = unit ? WEEKDAY_INDEX[unit] : undefined;
  if (weekday === undefined) return null;
  const monday = addDays(reference, -((dayOfWeek(reference) + 6) % 7));
  const mondayBasedWeekday = (weekday + 6) % 7;
  const start = addDays(monday, mondayBasedWeekday + offset * 7);
  return { start, end: addDays(start, 1) };
}

function resolveRelativeOffset(
  phrase: string,
  reference: CalendarDate,
): { start: CalendarDate; end: CalendarDate } | null {
  const future = /^in\s+(\S+)\s+(days?|weeks?|months?|years?)$/u.exec(phrase);
  const past = /^(\S+)\s+(days?|weeks?|months?|years?)\s+ago$/u.exec(phrase);
  const match = future ?? past;
  if (!match) return null;
  const amount = quantity(match[1] ?? "");
  const unit = match[2] ?? "";
  if (amount === null || amount < 1) return null;
  const direction = future ? 1 : -1;
  if (unit.startsWith("day")) return oneDay(addDays(reference, direction * amount));
  if (unit.startsWith("week")) {
    const monday = addDays(reference, -((dayOfWeek(reference) + 6) % 7));
    const start = addDays(monday, direction * amount * 7);
    return { start, end: addDays(start, 7) };
  }
  if (unit.startsWith("month")) {
    const start = addMonths({ ...reference, day: 1 }, direction * amount);
    return { start, end: addMonths(start, 1) };
  }
  const start = { year: reference.year + direction * amount, month: 1, day: 1 };
  return { start, end: { year: start.year + 1, month: 1, day: 1 } };
}

function resolveNamedMonth(
  phrase: string,
): { start: CalendarDate; end: CalendarDate } | null {
  const match = /^(\p{L}+)\s+(\d{4})$/u.exec(phrase);
  if (!match) return null;
  const month = MONTH_INDEX[(match[1] ?? "").slice(0, 3)];
  const year = Number(match[2]);
  if (!month || !Number.isInteger(year)) return null;
  const start = { year, month, day: 1 };
  return { start, end: addMonths(start, 1) };
}

function quantity(value: string): number | null {
  const numeric = /^\d+$/u.test(value) ? Number(value) : QUANTITY[value];
  return Number.isInteger(numeric) && (numeric ?? 0) <= 366 ? numeric ?? null : null;
}

function resolveExplicitDate(phrase: string, defaultYear: number): CalendarDate | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(phrase);
  if (iso) {
    return validCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  const named = /^(\p{L}+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/u.exec(
    phrase,
  );
  if (!named) return null;
  const monthToken = named[1];
  const month = monthToken ? MONTH_INDEX[monthToken.slice(0, 3)] : undefined;
  if (!month) return null;
  return validCalendarDate(
    named[3] ? Number(named[3]) : defaultYear,
    month,
    Number(named[2]),
  );
}

function validCalendarDate(year: number, month: number, day: number): CalendarDate | null {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function oneDay(start: CalendarDate): { start: CalendarDate; end: CalendarDate } {
  return { start, end: addDays(start, 1) };
}

function localCalendarDate(instant: Date, timeZone: string): CalendarDate {
  const parts = dateTimeParts(instant, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function zonedStartOfDay(date: CalendarDate, timeZone: string): string {
  const target = Date.UTC(date.year, date.month - 1, date.day);
  let low = target - 36 * 60 * 60 * 1_000;
  let high = target + 36 * 60 * 60 * 1_000;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const represented = localCalendarDate(new Date(middle), timeZone);
    if (compareCalendarDates(represented, date) < 0) low = middle + 1;
    else high = middle;
  }
  return new Date(low).toISOString();
}

function compareCalendarDates(left: CalendarDate, right: CalendarDate): number {
  return Date.UTC(left.year, left.month - 1, left.day) -
    Date.UTC(right.year, right.month - 1, right.day);
}

function dateTimeParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate(),
  };
}

function addMonths(date: CalendarDate, months: number): CalendarDate {
  const result = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: 1,
  };
}

function dayOfWeek(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}
