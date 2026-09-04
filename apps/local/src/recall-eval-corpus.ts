import type { SourceContext } from "@afternote/memory";

export type RecallEvaluationRevision = {
  content: string;
  source?: SourceContext;
};

export type RecallEvaluationNote = {
  key: string;
  id: string;
  content: string;
  source?: SourceContext;
  previousRevisions?: RecallEvaluationRevision[];
};

type RecallEvaluationCase = {
  id: string;
  query: string;
  expectedNoteKeys: string[];
  excludedNoteKeys?: string[];
  unsupported?: boolean;
  expectedCitationFragment?: string;
};

const SEMANTIC_SCENARIO_DEFINITIONS = [
  {
    sequence: 29,
    key: "semantic-launch-blocker",
    noteKey: "semantic-launch-blocker",
    content: "The deployment cannot proceed until the security review is approved.",
    source: { application: "Afternote Local", label: "Release blocker" },
    query: "What is preventing us from shipping?",
    documentPhrase: "deployment cannot proceed",
    queryPhrase: "preventing us from shipping",
  },
  {
    sequence: 30,
    key: "semantic-renewal-paraphrase",
    noteKey: "semantic-renewal-paraphrase",
    content: "The contractor renewal checklist was drafted in Basecamp by Omar Haddad.",
    source: {
      application: "Basecamp",
      author: "Omar Haddad",
      label: "Vendor operations",
    },
    query: "Who documented the supplier extension process in our project hub?",
    documentPhrase: "contractor renewal",
    queryPhrase: "supplier extension process",
  },
  {
    sequence: 31,
    key: "semantic-event-paraphrase",
    noteKey: "semantic-event-paraphrase",
    content: "The museum reservation is for July 6 at 10 AM.",
    source: { application: "Afternote Local", label: "Weekend plan" },
    query: "Which outing follows America's birthday?",
    documentPhrase: "museum reservation",
    queryPhrase: "outing follows america's birthday",
  },
  {
    sequence: 32,
    key: "semantic-access-paraphrase",
    noteKey: "semantic-access-paraphrase",
    content: "The spare studio key is taped beneath the lavender toolbox lid.",
    source: { application: "Claude", label: "Access detail" },
    query: "Where is the backup entrance pass for the art room?",
    documentPhrase: "lavender toolbox",
    queryPhrase: "backup entrance pass for the art room",
  },
] as const;

const EXISTING_NOTE_SEMANTIC_SCENARIOS = [
  {
    sequence: 2,
    key: "semantic-pricing-paraphrase",
    noteKey: "decision-pricing",
    query: "What does the pioneer cohort cost?",
    documentPhrase: "annual plan will stay at $96",
    queryPhrase: "pioneer cohort cost",
  },
  {
    sequence: 9,
    key: "semantic-medicine-paraphrase",
    noteKey: "prescription-pickup",
    query: "When can I collect my medicine?",
    documentPhrase: "allergy prescription",
    queryPhrase: "collect my medicine",
  },
  {
    sequence: 10,
    key: "semantic-tax-paraphrase",
    noteKey: "tax-document",
    query: "Where did I file the real estate assessment bill?",
    documentPhrase: "property tax statement",
    queryPhrase: "real estate assessment bill",
  },
  {
    sequence: 11,
    key: "semantic-reading-paraphrase",
    noteKey: "book-recommendation",
    query: "What should I read before talking to potential customers?",
    documentPhrase: "book the mom test",
    queryPhrase: "read before talking to potential customers",
  },
  {
    sequence: 12,
    key: "semantic-search-foundation-paraphrase",
    noteKey: "database-decision",
    query: "Which on-device lookup foundation did we choose ahead of vector similarity?",
    documentPhrase: "sqlite fts5",
    queryPhrase: "on-device lookup foundation",
  },
  {
    sequence: 14,
    key: "semantic-car-work-paraphrase",
    noteKey: "car-service",
    query: "What maintenance is scheduled for the vehicle?",
    documentPhrase: "oil change and brake inspection",
    queryPhrase: "maintenance is scheduled for the vehicle",
  },
  {
    sequence: 16,
    key: "semantic-proof-of-purchase-paraphrase",
    noteKey: "warranty-receipt",
    query: "Where can I find proof of purchase for my sit-stand workstation?",
    documentPhrase: "standing desk warranty receipt",
    queryPhrase: "proof of purchase for my sit-stand workstation",
  },
  {
    sequence: 18,
    key: "semantic-offline-copy-paraphrase",
    noteKey: "backup-drive",
    query: "Where should the detached duplicate be protected upon completion?",
    documentPhrase: "encrypted backup drive",
    queryPhrase: "detached duplicate be protected",
  },
  {
    sequence: 19,
    key: "semantic-coffee-paraphrase",
    noteKey: "coffee-order",
    query: "How is the regular espresso drink prepared?",
    documentPhrase: "oat milk cortado",
    queryPhrase: "espresso drink",
  },
  {
    sequence: 20,
    key: "semantic-rental-paraphrase",
    noteKey: "contract-renewal",
    query: "When must we decide whether to extend the workspace rental?",
    documentPhrase: "studio lease renewal",
    queryPhrase: "extend the workspace rental",
  },
] as const;

export const LOCAL_RECALL_SEMANTIC_SCENARIOS =
  [...SEMANTIC_SCENARIO_DEFINITIONS, ...EXISTING_NOTE_SEMANTIC_SCENARIOS].map((scenario) => ({
    ...scenario,
    noteId: evaluationNoteId(scenario.sequence),
  }));

export const LOCAL_RECALL_EVALUATION_CORPUS = {
  id: "local-delayed-recall",
  version: 8,
  notes: [
    note(1, "commitment-proposal", "Send John the revised proposal Friday afternoon.", {
      application: "Claude",
      label: "Client follow-up",
    }),
    note(2, "decision-pricing", "We decided the annual plan will stay at $96 for the early access group.", {
      application: "Afternote Local",
      label: "Pricing decision",
    }),
    note(3, "date-dentist", "Dentist appointment is October 14 at 9:30 AM on Pearl Street.", {
      application: "Codex",
      label: "Appointment",
    }),
    note(4, "name-plumber", "Call Elena Rivera about the kitchen sink leak before Tuesday.", {
      application: "Afternote Local",
      label: "Home repair",
    }),
    note(5, "source-author-launch", "The launch checklist covers rollback, checksums, and clean-profile installation.", {
      application: "Notion",
      author: "Maya Chen",
      label: "Release review",
    }),
    note(6, "source-linear-architecture", "Keep one runtime owner and make every memory operation carry its vault context.", {
      application: "Linear",
      label: "ARC-42",
      author: "Noah Williams",
    }),
    note(7, "garage-code", "The garage keypad code is written inside the blue envelope in the desk drawer.", {
      application: "Claude",
      label: "House detail",
    }),
    note(8, "travel-gate", "The Denver flight leaves from gate B32 and boarding starts at 6:10 AM.", {
      application: "Afternote Local",
      label: "Travel",
    }),
    note(9, "prescription-pickup", "Pick up the allergy prescription from Pine Pharmacy after 4 PM Thursday.", {
      application: "Codex",
      label: "Errand",
    }),
    note(10, "tax-document", "The 2025 property tax statement is saved in the green filing box.", {
      application: "Afternote Local",
      label: "Records",
    }),
    note(11, "book-recommendation", "Priya recommended the book The Mom Test for customer interviews.", {
      application: "Claude",
      label: "Reading",
    }),
    note(12, "database-decision", "Use SQLite FTS5 as the deterministic retrieval baseline before adding embeddings.", {
      application: "Codex",
      label: "Architecture decision",
    }),
    note(13, "garden-supplies", "Buy two bags of compost and tomato stakes for the back garden.", {
      application: "Afternote Local",
      label: "Garden",
    }),
    note(14, "car-service", "The Subaru service appointment includes an oil change and brake inspection.", {
      application: "Claude",
      label: "Car",
    }),
    note(15, "team-lunch", "Team lunch is booked at Saffron Table for noon next Wednesday.", {
      application: "Afternote Local",
      label: "Team",
    }),
    note(16, "warranty-receipt", "The standing desk warranty receipt is in the receipts folder under office furniture.", {
      application: "Codex",
      label: "Warranty",
    }),
    note(17, "trail-meeting", "Meet Sam at the north trail entrance and bring the printed map.", {
      application: "Claude",
      label: "Weekend plan",
    }),
    note(18, "backup-drive", "The encrypted backup drive belongs in the fire safe after the monthly copy finishes.", {
      application: "Afternote Local",
      label: "Backup routine",
    }),
    note(19, "coffee-order", "Jordan's coffee order is a small oat milk cortado with no sugar.", {
      application: "Codex",
      label: "People",
    }),
    note(20, "contract-renewal", "The studio lease renewal decision is due on November 3.", {
      application: "Afternote Local",
      label: "Deadline",
    }),
    note(21, "temporal-farm-task", "I had to repair the north fence at the farm last Friday.", {
      application: "Afternote Local",
      label: "Farm log",
    }),
    note(22, "temporal-monthly-report", "Sarah filed the annual report last month.", {
      application: "Codex",
      label: "Reporting",
    }),
    note(23, "temporal-monthly-report-future", "Sarah will file the annual report next month.", {
      application: "Codex",
      label: "Reporting",
    }),
    note(24, "team-lunch-past", "Team lunch was booked at Saffron Table for noon last Wednesday.", {
      application: "Afternote Local",
      label: "Team",
    }),
    note(
      25,
      "revision-current-location",
      "The emergency keycard moved to the green fireproof box upstairs.",
      {
        application: "Afternote Local",
        label: "Access detail",
      },
      [{
        content: "The emergency keycard is inside the crimson accordion folder in the basement.",
      }],
    ),
    note(
      26,
      "duplicate-archive-token-a",
      "The duplicate archive token is stored in locker Q17.",
      {
        application: "Afternote Local",
        label: "Archive access",
      },
    ),
    note(
      27,
      "duplicate-archive-token-b",
      "The duplicate archive token is stored in locker Q17.",
      {
        application: "Afternote Local",
        label: "Archive access",
      },
    ),
    note(
      28,
      "long-note-tail",
      longEvaluationNote(),
      {
        application: "Codex",
        label: "Operations handbook",
      },
    ),
    note(33, "source-time-chat", "Maya posted that the product demo script was ready.", {
      application: "Team Chat",
      author: "Maya Chen",
      label: "Product demo",
      timestamp: "2026-01-09T18:30:00.000Z",
    }),
    note(34, "source-time-claude", "Claude recorded the signed venue agreement.", {
      application: "Claude",
      label: "Venue agreement",
      timestamp: "2025-12-20T16:00:00.000Z",
    }),
    note(35, "source-time-local", "The trail cleanup begins at the east entrance.", {
      application: "Afternote Local",
      label: "Weekend plan",
      timestamp: "2026-01-24T15:00:00.000Z",
    }),
  ],
  cases: [
    evaluationCase("commitment-proposal", "What proposal did I need to send John?", ["commitment-proposal"]),
    evaluationCase("decision-pricing", "What did we decide about the annual early access price?", ["decision-pricing"]),
    evaluationCase("date-dentist", "When is the Pearl Street dentist appointment?", ["date-dentist"]),
    evaluationCase("name-plumber", "Who should I call about the kitchen sink leak?", ["name-plumber"]),
    evaluationCase("source-author", "What did Maya Chen write?", ["source-author-launch"]),
    evaluationCase("source-label", "What was recorded in Linear ARC-42?", ["source-linear-architecture"]),
    evaluationCase("garage-code", "Where is the garage keypad code?", ["garage-code"]),
    evaluationCase("travel-gate", "Which gate has the Denver flight?", ["travel-gate"]),
    evaluationCase("prescription-time", "When can I collect the Pine Pharmacy prescription?", ["prescription-pickup"]),
    evaluationCase("tax-location", "Where is the 2025 property tax statement?", ["tax-document"]),
    evaluationCase("book-person", "Which customer interview book did Priya recommend?", ["book-recommendation"]),
    evaluationCase("retrieval-decision", "What deterministic retrieval baseline did we choose?", ["database-decision"]),
    evaluationCase("temporal-last-friday", "What did I have to do last Friday?", ["temporal-farm-task"]),
    evaluationCase("temporal-last-month-year-boundary", "What report did Sarah file last month?", ["temporal-monthly-report"]),
    evaluationCase("temporal-next-weekday", "Where is team lunch next Wednesday?", ["team-lunch"]),
    evaluationCase("temporal-ambiguous-weekday-lexical", "What proposal was I sending Friday afternoon?", ["commitment-proposal"]),
    evaluationCase("source-time-last-friday", "What did Maya post last Friday?", ["source-time-chat"]),
    evaluationCase("source-time-last-month", "Which agreement was recorded last month?", ["source-time-claude"]),
    evaluationCase("source-time-next-weekend", "What begins next weekend?", ["source-time-local"]),
    evaluationCase(
      "revision-current-location",
      "Where is the emergency keycard?",
      ["revision-current-location"],
      { expectedCitationFragment: "green fireproof box" },
    ),
    evaluationCase("revision-stale-location", "crimson accordion", [], {
      excludedNoteKeys: ["revision-current-location"],
    }),
    evaluationCase("duplicate-identical-notes", "Where is the duplicate archive token?", ["duplicate-archive-token-a", "duplicate-archive-token-b"]),
    evaluationCase(
      "long-note-tail-citation",
      "Where is the amber shutdown binder?",
      ["long-note-tail"],
      { expectedCitationFragment: "amber shutdown binder" },
    ),
    evaluationCase("unsupported-weather", "What will the weather be in Lisbon tomorrow?", [], { unsupported: true }),
    evaluationCase("unsupported-inbox", "Summarize my unread email inbox", [], { unsupported: true }),
    evaluationCase("unsupported-source-field", "Which application recorded this?", [], { unsupported: true }),
    evaluationCase("unsupported-empty", "what is this about", [], { unsupported: true }),
  ],
  semanticNotes: SEMANTIC_SCENARIO_DEFINITIONS.map((scenario) =>
    note(
      scenario.sequence,
      scenario.key,
      scenario.content,
      scenario.source,
    ),
  ),
  semanticCases: LOCAL_RECALL_SEMANTIC_SCENARIOS.map((scenario) =>
    evaluationCase(scenario.key, scenario.query, [scenario.noteKey]),
  ),
} as const;

function note(
  sequence: number,
  key: string,
  content: string,
  source?: SourceContext,
  previousRevisions?: RecallEvaluationNote["previousRevisions"],
): RecallEvaluationNote {
  return {
    key,
    id: evaluationNoteId(sequence),
    content,
    source,
    previousRevisions,
  };
}

function evaluationNoteId(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

function longEvaluationNote(): string {
  return (
    "The operations handbook records routine opening checks, supply counts, room assignments, " +
    "equipment labels, and weekly maintenance notes. ".repeat(8) +
    "The amber shutdown binder is clipped behind the west loading-dock map."
  );
}

function evaluationCase(
  id: string,
  query: string,
  expectedNoteKeys: string[],
  options: Pick<
    RecallEvaluationCase,
    "unsupported" | "expectedCitationFragment" | "excludedNoteKeys"
  > = {},
): RecallEvaluationCase {
  return { id, query, expectedNoteKeys, ...options };
}
