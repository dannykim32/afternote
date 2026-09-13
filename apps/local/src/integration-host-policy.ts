export const MCP_HOST_CODE_REQUIREMENTS = {
  codex:
    'identifier "codex" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "2DC432GLL2"',
  claude:
    'identifier "com.anthropic.claude-code" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "Q6L2SF6YDW"',
  "claude-desktop":
    'identifier "disclaimer" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "Q6L2SF6YDW"',
} as const;

export const INTEGRATION_HOST_CODE_REQUIREMENTS = {
  Codex: MCP_HOST_CODE_REQUIREMENTS.codex,
  "Claude Code": MCP_HOST_CODE_REQUIREMENTS.claude,
  "Claude Desktop":
    'identifier "com.anthropic.claudefordesktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "Q6L2SF6YDW"',
} as const;

export const MCP_HOST_CODE_POLICIES = {
  codex: { parent: MCP_HOST_CODE_REQUIREMENTS.codex },
  claude: { parent: MCP_HOST_CODE_REQUIREMENTS.claude },
  "claude-desktop": {
    parent: MCP_HOST_CODE_REQUIREMENTS["claude-desktop"],
    grandparent: INTEGRATION_HOST_CODE_REQUIREMENTS["Claude Desktop"],
  },
} as const;

export type IntegrationHostName = keyof typeof INTEGRATION_HOST_CODE_REQUIREMENTS;
