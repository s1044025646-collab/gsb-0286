import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { CrcParams } from "./crc";

export interface SessionRow {
  id: string;
  params: CrcParams;
  reg: number;
  length: number;
  finalized: boolean;
  finalDigest: number | null;
  createdAt: string;
}

/**
 * SQLite 持久化：保存参数快照（而非预设名）、未收尾寄存器、
 * 已处理长度、块顺序与最终摘要。重启后按快照恢复，与后来修改的预设无关。
 */
export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        params TEXT NOT NULL,
        reg INTEGER NOT NULL,
        length INTEGER NOT NULL,
        finalized INTEGER NOT NULL DEFAULT 0,
        final_digest INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        hex TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createSession(id: string, params: CrcParams): void {
    this.db
      .prepare(
        "INSERT INTO sessions (id, params, reg, length, finalized, final_digest, created_at) VALUES (?, ?, ?, 0, 0, NULL, ?)",
      )
      .run(id, JSON.stringify(params), params.init >>> 0, new Date().toISOString());
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      params: JSON.parse(row.params),
      reg: row.reg >>> 0,
      length: row.length,
      finalized: row.finalized === 1,
      finalDigest: row.final_digest === null ? null : row.final_digest >>> 0,
      createdAt: row.created_at,
    };
  }

  appendBlock(sessionId: string, seq: number, hex: string, reg: number, length: number): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO blocks (session_id, seq, hex) VALUES (?, ?, ?)").run(sessionId, seq, hex);
      this.db.prepare("UPDATE sessions SET reg = ?, length = ? WHERE id = ?").run(reg >>> 0, length, sessionId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  finalizeSession(id: string, digest: number): void {
    this.db.prepare("UPDATE sessions SET finalized = 1, final_digest = ? WHERE id = ?").run(digest >>> 0, id);
  }

  listBlocks(sessionId: string): { seq: number; hex: string }[] {
    return this.db
      .prepare("SELECT seq, hex FROM blocks WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as any;
  }

  blockCount(sessionId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM blocks WHERE session_id = ?").get(sessionId) as any;
    return row.c;
  }
}
