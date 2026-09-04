import type { Note } from "@afternote/memory";

export type OrganizationFacetKind = "people" | "sources" | "topics";
export type OrganizationBrowseKind = OrganizationFacetKind | "dates";

export type OrganizationFacetSummary = {
  key: string;
  label: string;
  noteCount: number;
};

export type NoteOrganization = {
  label: string;
  people: string[];
  sources: string[];
  topics: string[];
};

export type OrganizationOverview = {
  people: OrganizationFacetSummary[];
  sources: OrganizationFacetSummary[];
  topics: OrganizationFacetSummary[];
  dates: OrganizationFacetSummary[];
};

const TOPIC_STOP_WORDS = new Set([
  "about", "after", "again", "against", "alpha", "also", "and", "approved",
  "are", "before", "but", "call", "can", "could",
  "checkpoint", "day", "decided", "did", "does", "doing", "done", "evidence",
  "explicit", "follow-up", "for", "friday",
  "from", "had", "has", "have", "her", "him", "his", "how", "into", "its",
  "local", "met", "need", "not", "note", "now", "our",
  "out", "own", "owns", "plan", "remains", "said", "saved", "send", "she",
  "should", "that", "the", "their", "them", "then", "there", "they",
  "this", "through", "tomorrow", "tuesday", "until", "was", "we", "were", "what",
  "when", "where", "which", "who", "will", "with", "would", "you", "your",
]);

const NAME_PREFIX_PATTERN =
  /\b(?:[Mm]et\s+with|[Ff]ollow(?:ed)?\s+up\s+with|[Ww]ith|[Cc]all|[Ee]mail|[Aa]sk|[Tt]ell|[Mm]eet|[Ss]end)\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})/gu;
const NAME_SUBJECT_PATTERN =
  /\b([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})\s+(?:approved|recommended|owns|said|wrote)\b/gu;
const NAME_POSSESSIVE_PATTERN =
  /\b([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})['’]s\b/gu;

export function deriveNoteOrganization(
  note: Pick<Note, "content" | "source">,
): NoteOrganization {
  const people = uniqueLabels([
    ...(note.source?.author ? [note.source.author] : []),
    ...matchingNames(note.content),
  ]);
  const sources = uniqueLabels(
    note.source?.application ? [note.source.application] : [],
  );
  const excludedTokens = new Set(
    [...people, ...sources]
      .flatMap((label) => label.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
  );
  const topicInput = [note.source?.label, note.content].filter(Boolean).join(" ");
  const topics = matchingTopics(topicInput, excludedTokens);
  return {
    label: compactNoteLabel(note.content),
    people,
    sources,
    topics,
  };
}

export function compactNoteLabel(content: string): string {
  const compact = content
    .replace(/^\s*(?:-\s*\[[ xX]\]\s*|[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  const firstThought = compact.split(/(?:[.!?](?:\s|$)|\n)/u, 1)[0]?.trim() ?? "";
  const candidate = firstThought || compact || "Untitled note";
  return candidate.length > 72 ? `${candidate.slice(0, 69).trimEnd()}…` : candidate;
}

export function organizationFacetKey(label: string): string {
  return label.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function organizationDateRanges(now = new Date()): Array<{
  key: string;
  label: string;
  start: string | null;
  end: string | null;
}> {
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startTomorrow = new Date(
    startToday.getFullYear(),
    startToday.getMonth(),
    startToday.getDate() + 1,
  );
  const startYesterday = new Date(
    startToday.getFullYear(),
    startToday.getMonth(),
    startToday.getDate() - 1,
  );
  const daysSinceMonday = (startToday.getDay() + 6) % 7;
  const startWeek = new Date(
    startToday.getFullYear(),
    startToday.getMonth(),
    startToday.getDate() - daysSinceMonday,
  );
  const startThisWeek =
    startWeek.getTime() < startYesterday.getTime() ? startWeek : startYesterday;
  return [
    {
      key: "today",
      label: "Today",
      start: startToday.toISOString(),
      end: startTomorrow.toISOString(),
    },
    {
      key: "yesterday",
      label: "Yesterday",
      start: startYesterday.toISOString(),
      end: startToday.toISOString(),
    },
    {
      key: "this-week",
      label: "This week",
      start: startThisWeek.toISOString(),
      end: startYesterday.toISOString(),
    },
    {
      key: "older",
      label: "Older",
      start: null,
      end: startThisWeek.toISOString(),
    },
  ];
}

export function isOrganizationFacetKind(
  value: string,
): value is OrganizationFacetKind {
  return value === "people" || value === "sources" || value === "topics";
}

function matchingNames(content: string): string[] {
  const matches: string[] = [];
  for (const pattern of [
    NAME_PREFIX_PATTERN,
    NAME_SUBJECT_PATTERN,
    NAME_POSSESSIVE_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      if (match[1]) matches.push(match[1]);
    }
  }
  return matches;
}

function matchingTopics(input: string, excludedTokens: ReadonlySet<string>): string[] {
  const topics = new Map<string, string>();
  const tokens = input
    .toLocaleLowerCase()
    .matchAll(/[\p{L}][\p{L}\p{N}'’-]{2,}/gu);
  for (const match of tokens) {
    const token = match[0];
    if (
      TOPIC_STOP_WORDS.has(token) ||
      excludedTokens.has(token) ||
      /^\d+$/u.test(token)
    ) {
      continue;
    }
    const label = titleCase(token);
    const key = organizationFacetKey(label);
    if (!topics.has(key)) topics.set(key, label);
    if (topics.size === 6) break;
  }
  return [...topics.values()];
}

function uniqueLabels(values: readonly string[]): string[] {
  const labels = new Map<string, string>();
  for (const value of values) {
    const label = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!label || label.length > 200) continue;
    const key = organizationFacetKey(label);
    if (!labels.has(key)) labels.set(key, label);
  }
  return [...labels.values()];
}

function titleCase(value: string): string {
  return value ? `${value[0]!.toLocaleUpperCase()}${value.slice(1)}` : value;
}
