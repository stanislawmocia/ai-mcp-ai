import type Database from 'better-sqlite3';

export interface ContextEntry {
  key: string;
  data: unknown;
  sharedWith: string[] | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContextStore {
  set(key: string, data: unknown, sharedWith?: string[], ttlHours?: number): void;
  get(key: string): ContextEntry | null;
  remove(key: string): void;
}

export function createContextStore(db: Database.Database): ContextStore {
  const upsertStmt = db.prepare(`
    INSERT INTO context (key, data, shared_with, expires_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      data = excluded.data,
      shared_with = excluded.shared_with,
      expires_at = excluded.expires_at,
      updated_at = datetime('now')
  `);

  const getStmt = db.prepare(`
    SELECT * FROM context
    WHERE key = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
  `);

  const deleteStmt = db.prepare('DELETE FROM context WHERE key = ?');

  // Cleanup expired entries periodically
  setInterval(() => {
    db.prepare("DELETE FROM context WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')").run();
  }, 60_000).unref();

  function rowToEntry(row: Record<string, unknown>): ContextEntry {
    return {
      key: row.key as string,
      data: JSON.parse(row.data as string),
      sharedWith: row.shared_with ? JSON.parse(row.shared_with as string) : null,
      expiresAt: row.expires_at as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  return {
    set(key, data, sharedWith, ttlHours) {
      const expiresAt = ttlHours
        ? new Date(Date.now() + ttlHours * 3600_000).toISOString()
        : null;
      upsertStmt.run(
        key,
        JSON.stringify(data),
        sharedWith ? JSON.stringify(sharedWith) : null,
        expiresAt,
      );
    },

    get(key) {
      const row = getStmt.get(key) as Record<string, unknown> | undefined;
      return row ? rowToEntry(row) : null;
    },

    remove(key) {
      deleteStmt.run(key);
    },
  };
}
