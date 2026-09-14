export type BrokerClientKind =
  | "codex"
  | "claude"
  | "claude-desktop"
  | "local_ui";

export function brokerClientDisplayLabel(kind: BrokerClientKind): string {
  switch (kind) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude Code";
    case "claude-desktop":
      return "Claude Desktop";
    case "local_ui":
      return "Afternote Local";
  }
}
