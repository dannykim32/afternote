# Local application

Afternote Local is split across four security roles:

1. `Afternote.app` presents Library, Connections, and owner-approved administration.
2. The native gateway authenticates signed peers and owns the private worker process.
3. The worker is the only component that retrieves the Keychain vault key and opens
   SQLCipher.
4. Connector clients for Codex and Claude Code hold separate scoped identities. They can
   request Memory operations but cannot access SQL, Keychain, Library administration, or
   lifecycle controls.

The MCP surface exposes Remember, Recall, and Get. Deletion remains an owner action in the
native app; connectors receive no deletion scope. Returned note content is labeled as
untrusted data and includes durable source metadata.

## Useful commands

```text
afternote codex install|status|remove|rotate-identity
afternote claude-code install|status|remove|rotate-identity
afternote connections
afternote ui
afternote export /absolute/path/to/export.json
afternote export-markdown /absolute/path/to/notes.md
afternote doctor
afternote lock
afternote unlock
```

JSON export is lossless and restoreable only into a clean vault. Its checksum detects
corruption; it is not a signature and does not authenticate who created the file. Restore
requires fresh owner presence, binds approval to the exact canonical path and digest, and
strictly validates the bounded interchange format before creating an encrypted vault.
Markdown is for reading and cannot be restored.

See [the public security model](../../docs/SECURITY_MODEL.md) for trust assumptions and
[the packaging guide](packaging/README.md) for installation behavior.
