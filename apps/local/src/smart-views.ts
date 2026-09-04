import type { SourceContext } from "@afternote/memory";

export const SYSTEM_SMART_VIEWS = [
  {
    id: "decisions",
    label: "Decisions",
    description: "Choices and approvals you explicitly saved.",
  },
  {
    id: "commitments",
    label: "Commitments",
    description: "Follow-ups, promises, and due work.",
  },
  {
    id: "meetings",
    label: "Meetings",
    description: "Notes saved from calls, reviews, and one-on-ones.",
  },
] as const;

export type SystemSmartViewId = (typeof SYSTEM_SMART_VIEWS)[number]["id"];

export type SmartViewSummary = (typeof SYSTEM_SMART_VIEWS)[number] & {
  noteCount: number;
};

export function deriveSystemSmartViewIds(note: {
  content: string;
  source?: SourceContext | null;
}): SystemSmartViewId[] {
  const content = note.content.toLocaleLowerCase();
  const sourceApplication = note.source?.application?.toLocaleLowerCase() ?? "";
  const sourceLabel = note.source?.label?.toLocaleLowerCase() ?? "";
  const ids: SystemSmartViewId[] = [];

  if (/\b(decided|decision|approved|chose|chosen|agreed)\b/u.test(content)) {
    ids.push("decisions");
  }
  if (
    /\b(i|we)\s+(will|shall|need to|plan to|committed to)\b/u.test(content) ||
    /\b(i['’]ll|we['’]ll|follow[- ]?up|deadline|due)\b/u.test(content)
  ) {
    ids.push("commitments");
  }
  if (
    /\b(zoom|google meet|google calendar|calendar|granola|fathom)\b/u.test(
      sourceApplication,
    ) ||
    /\b(meeting|one[- ]on[- ]one|1:1|standup|sync|retro|review|huddle)\b/u.test(
      `${sourceLabel} ${content}`,
    )
  ) {
    ids.push("meetings");
  }
  return ids;
}

export function isSystemSmartViewId(value: string): value is SystemSmartViewId {
  return SYSTEM_SMART_VIEWS.some((view) => view.id === value);
}
