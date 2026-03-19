import crypto from 'node:crypto';
import type { Database } from 'bun:sqlite';

export interface Task {
  id: string;
  type: string;
  nodeName: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'failed';
  result: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBroker {
  createTask(type: string, nodeName: string, payload: Record<string, unknown>): Task;
  getTask(id: string): Task | null;
  updateTask(id: string, status: Task['status'], result?: unknown): void;
  listTasks(status?: Task['status']): Task[];
}

export function createBroker(db: Database): TaskBroker {
  const insertStmt = db.prepare(`
    INSERT INTO tasks (id, type, node_name, payload, status)
    VALUES (?, ?, ?, ?, 'pending')
  `);

  const getStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');

  const updateStmt = db.prepare(`
    UPDATE tasks SET status = ?, result = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const listAllStmt = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100');
  const listByStatusStmt = db.prepare(
    'SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT 100',
  );

  function rowToTask(row: Record<string, unknown>): Task {
    return {
      id: row.id as string,
      type: row.type as string,
      nodeName: row.node_name as string,
      payload: JSON.parse(row.payload as string),
      status: row.status as Task['status'],
      result: row.result ? JSON.parse(row.result as string) : null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  return {
    createTask(type, nodeName, payload) {
      const id = `task-${crypto.randomUUID().slice(0, 8)}`;
      insertStmt.run(id, type, nodeName, JSON.stringify(payload));
      return this.getTask(id)!;
    },

    getTask(id) {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? rowToTask(row) : null;
    },

    updateTask(id, status, result) {
      updateStmt.run(status, result ? JSON.stringify(result) : null, id);
    },

    listTasks(status?) {
      const rows = (status ? listByStatusStmt.all(status) : listAllStmt.all()) as Record<
        string,
        unknown
      >[];
      return rows.map(rowToTask);
    },
  };
}
