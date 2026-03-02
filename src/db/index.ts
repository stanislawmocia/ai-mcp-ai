import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return _db;
}

export function initDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  applySchema(_db);
  return _db;
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS keypairs (
      id INTEGER PRIMARY KEY,
      public_key TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      from_alias TEXT,
      from_ip TEXT,
      to_alias TEXT,
      to_ip TEXT,
      content TEXT NOT NULL,
      reply_to_id TEXT,
      message_type TEXT DEFAULT 'message',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
    CREATE INDEX IF NOT EXISTS idx_messages_from_alias ON messages(from_alias);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_id);

    CREATE TABLE IF NOT EXISTS peers (
      alias TEXT PRIMARY KEY,
      tailscale_ip TEXT NOT NULL,
      public_key TEXT DEFAULT '',
      mac_address TEXT DEFAULT '',
      preferred_agent TEXT DEFAULT 'claude',
      ssh_user TEXT DEFAULT '',
      auto_wake INTEGER DEFAULT 0,
      last_seen TEXT
    );

    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// Message types
export interface Message {
  id: string;
  direction: "in" | "out";
  from_alias: string | null;
  from_ip: string | null;
  to_alias: string | null;
  to_ip: string | null;
  content: string;
  reply_to_id: string | null;
  message_type: string;
  status: string;
  created_at: string;
}

export interface Peer {
  alias: string;
  tailscale_ip: string;
  public_key: string;
  mac_address: string;
  preferred_agent: string;
  ssh_user: string;
  auto_wake: number;
  last_seen: string | null;
}

// Message operations
export const messages = {
  insert(msg: Omit<Message, "created_at">): void {
    const db = getDb();
    db.prepare(`
      INSERT INTO messages (id, direction, from_alias, from_ip, to_alias, to_ip, content, reply_to_id, message_type, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      msg.direction,
      msg.from_alias,
      msg.from_ip,
      msg.to_alias,
      msg.to_ip,
      msg.content,
      msg.reply_to_id,
      msg.message_type,
      msg.status
    );
  },

  findById(id: string): Message | undefined {
    return getDb()
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(id) as Message | undefined;
  },

  findIncoming(opts: {
    from?: string;
    unread_only?: boolean;
    limit?: number;
    message_type?: string;
  }): Message[] {
    const db = getDb();
    const conditions: string[] = ["direction = 'in'"];
    const params: unknown[] = [];

    if (opts.from) {
      conditions.push("from_alias = ?");
      params.push(opts.from);
    }
    if (opts.unread_only) {
      conditions.push("status != 'read'");
    }
    if (opts.message_type) {
      conditions.push("message_type = ?");
      params.push(opts.message_type);
    }

    params.push(opts.limit ?? 20);

    return db
      .prepare(
        `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`
      )
      .all(...params) as Message[];
  },

  markAsRead(id: string): void {
    getDb()
      .prepare("UPDATE messages SET status = 'read' WHERE id = ?")
      .run(id);
  },

  markStatus(id: string, status: string): void {
    getDb()
      .prepare("UPDATE messages SET status = ? WHERE id = ?")
      .run(status, id);
  },

  countUnread(): number {
    const row = getDb()
      .prepare("SELECT COUNT(*) as c FROM messages WHERE direction = 'in' AND status != 'read'")
      .get() as { c: number };
    return row.c;
  },

  findReplies(messageId: string): Message[] {
    return getDb()
      .prepare("SELECT * FROM messages WHERE reply_to_id = ? AND direction = 'in' ORDER BY created_at ASC")
      .all(messageId) as Message[];
  },
};

// Peer operations
export const peers = {
  upsert(peer: Partial<Peer> & { alias: string; tailscale_ip: string }): void {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM peers WHERE alias = ?").get(peer.alias) as Peer | undefined;

    if (existing) {
      const fields = Object.keys(peer)
        .filter((k) => k !== "alias")
        .map((k) => `${k} = ?`);
      const values = Object.keys(peer)
        .filter((k) => k !== "alias")
        .map((k) => (peer as Record<string, unknown>)[k]);

      if (fields.length > 0) {
        db.prepare(`UPDATE peers SET ${fields.join(", ")} WHERE alias = ?`).run(...values, peer.alias);
      }
    } else {
      db.prepare(`
        INSERT INTO peers (alias, tailscale_ip, public_key, mac_address, preferred_agent, ssh_user, auto_wake)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        peer.alias,
        peer.tailscale_ip,
        peer.public_key ?? "",
        peer.mac_address ?? "",
        peer.preferred_agent ?? "claude",
        peer.ssh_user ?? "",
        peer.auto_wake ?? 0
      );
    }
  },

  findByAlias(alias: string): Peer | undefined {
    return getDb()
      .prepare("SELECT * FROM peers WHERE alias = ?")
      .get(alias) as Peer | undefined;
  },

  findByIp(ip: string): Peer | undefined {
    return getDb()
      .prepare("SELECT * FROM peers WHERE tailscale_ip = ?")
      .get(ip) as Peer | undefined;
  },

  updatePublicKey(alias: string, publicKey: string): void {
    getDb()
      .prepare("UPDATE peers SET public_key = ?, last_seen = datetime('now') WHERE alias = ?")
      .run(publicKey, alias);
  },

  updateLastSeen(alias: string): void {
    getDb()
      .prepare("UPDATE peers SET last_seen = datetime('now') WHERE alias = ?")
      .run(alias);
  },

  all(): Peer[] {
    return getDb().prepare("SELECT * FROM peers").all() as Peer[];
  },
};

// State operations
export const state = {
  get(key: string): string | null {
    const row = getDb()
      .prepare("SELECT value FROM state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  },

  set(key: string, value: string): void {
    getDb()
      .prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)")
      .run(key, value);
  },

  delete(key: string): void {
    getDb().prepare("DELETE FROM state WHERE key = ?").run(key);
  },
};

// Keypair operations
export const keypairs = {
  get(): { public_key: string; secret_key: string; salt: string } | undefined {
    return getDb()
      .prepare("SELECT public_key, secret_key, salt FROM keypairs ORDER BY id DESC LIMIT 1")
      .get() as { public_key: string; secret_key: string; salt: string } | undefined;
  },

  save(publicKey: string, encryptedSecretKey: string, salt: string): void {
    getDb()
      .prepare("INSERT INTO keypairs (public_key, secret_key, salt) VALUES (?, ?, ?)")
      .run(publicKey, encryptedSecretKey, salt);
  },
};

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
