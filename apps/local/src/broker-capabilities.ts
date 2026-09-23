import { MEMORY_CAPABILITIES, type MemoryCapability } from "@afternote/memory";

export const ARCHIVE_CAPABILITIES = ["archive.search", "archive.read"] as const;
export type ArchiveCapability = typeof ARCHIVE_CAPABILITIES[number];
export type BrokerCapability = MemoryCapability | ArchiveCapability;
export const BROKER_CAPABILITIES: readonly BrokerCapability[] = [...MEMORY_CAPABILITIES, ...ARCHIVE_CAPABILITIES];
