// Applied only by the Vault's verified pre-migration backup/migration path.
export const CONVERSATION_ARCHIVE_SCHEMA = `
  create table if not exists conversation_archives (
    id text primary key,
    title text not null,
    state text not null check (state in ('importing', 'ready')),
    expected_bytes integer not null,
    sha256 text not null,
    saved_bytes integer not null default 0,
    passage_count integer not null default 0,
    created_at text not null
  );
  create table if not exists conversation_passages (
    rowid integer primary key,
    archive_id text not null references conversation_archives(id) on delete cascade,
    passage_index integer not null,
    text text not null,
    unique (archive_id, passage_index)
  );
  create virtual table if not exists conversation_passages_fts using fts5(
    text, content = 'conversation_passages', content_rowid = 'rowid', tokenize = 'unicode61'
  );
  create trigger if not exists conversation_passages_insert after insert on conversation_passages begin
    insert into conversation_passages_fts(rowid, text) values (new.rowid, new.text);
  end;
  create trigger if not exists conversation_passages_delete after delete on conversation_passages begin
    insert into conversation_passages_fts(conversation_passages_fts, rowid, text)
      values ('delete', old.rowid, old.text);
  end;
`;
