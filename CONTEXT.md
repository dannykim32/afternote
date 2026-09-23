# Afternote Local

Afternote Local gives one person durable, explicitly saved memory that remains under their control on one Mac.

## Language

**Note**:
A durable piece of content the owner explicitly saves in Afternote, together with optional source context.
_Avoid_: Memory item, document

**Revision**:
An immutable historical version of a Note. Exactly one Revision is current at a time.
_Avoid_: Edit, snapshot

**Vault**:
The encrypted collection containing Notes, Revisions, Archives, authorization records, and rebuildable indexes on one Mac.
_Avoid_: Account, workspace, database

**Archive**:
One immutable transcript explicitly imported from a real UTF-8 file. A paused import is not searchable or readable by Connectors.

**Passage**:
A bounded, ordered part of an Archive. Concatenating all Passages preserves the transcript bytes; page indexes provide citations.

**Archive access**:
A separate Owner-approved grant allowing one Connector to search and read all completed Archives. Ordinary Note permission does not include it.

**Owner**:
The person whose macOS presence authorizes privileged Vault operations.
_Avoid_: Administrator, account holder

**Connector**:
An approved AI host through which the Owner can explicitly Remember or Recall Notes.
_Avoid_: Integration, plugin, client

**Connector identity**:
The device-bound cryptographic identity that distinguishes one Connector installation from another.
_Avoid_: API key, account identity

**Connection**:
A short-lived, scoped authorization that lets a Connector access the Vault through the broker.
_Avoid_: Login, token

**Work session**:
An Owner-approved time window during which a paired Connector may establish Connections without repeating owner presence.
_Avoid_: Connection, login session

**Remember**:
The explicit act of saving a Note through a Connector.
_Avoid_: Capture, ingest

**Recall**:
Ranked retrieval of explicitly saved Notes with durable source context.
_Avoid_: Search, generation

**Derived index**:
A rebuildable local representation used to organize or retrieve Notes; it is never the source of truth.
_Avoid_: Note store, cache
