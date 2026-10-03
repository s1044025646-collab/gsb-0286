import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { CrcParams } from "./crc";

export interface SessionRow {
  id: number;
  name: string | null;
  params: CrcParams;
  presetName: string | null;
  reg: number;
  length: number;
  finalized: boolean;
  finalDigest: number | null;
  createdAt: string;
}

export interface BlockRow {
  seq: number;
  hex: string;
  length: number;
  createdAt: string;
}

/**
 * SQLite 持久化。保存：参数快照（真实参数，不依赖预设名）、
 * 内部未收尾寄存器、已处理长度、块顺序、最终摘要。
 * 重启后按会话 id 恢复，参数永远取自建会话时的快照。
 */
export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "crc.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        params_json TEXT NOT NULL,
        preset_name TEXT,
        reg INTEGER NOT NULL,
        length INTEGER NOT NULL,
        finalized INTEGER NOT NULL DEFAULT 0,
        final_digest INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        hex TEXT NOT NULL,
        length INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_session ON blocks(session_id, seq);
    `);
  }

  close(): void {
    this.db.close();
  }

  createSession(name: string | null, params: CrcParams, presetName: string | null): SessionRow {
    const stmt = this.db.prepare(
      `INSERT INTO sessions (name, params_json, preset_name, reg, length, finalized, final_digest, created_at)
       VALUES (?, ?, ?, ?, 0, 0, NULL, ?)`
    );
    const res = stmt.run(name, JSON.stringify(params), presetName, params.init, new Date().toISOString());
    return this.getSession(Number(res.lastInsertRowid))!;
  }

  getSession(id: number): SessionRow | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
    return row ? this.mapSession(row) : null;
  }

  listSessions(): SessionRow[] {
    const rows = this.db.prepare(`SELECT * FROM sessions ORDER BY id`).all() as any[];
    return rows.map((r) => this.mapSession(r));
  }

  updateState(id: number, reg: number, length: number): void {
    this.db.prepare(`UPDATE sessions SET reg = ?, length = ? WHERE id = ?`).run(reg, length, id);
  }

  finalize(id: number, finalDigest: number): void {
    this.db.prepare(`UPDATE sessions SET finalized = 1, final_digest = ? WHERE id = ?`).run(finalDigest, id);
  }

  appendBlock(sessionId: number, hex: string, length: number): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM blocks WHERE session_id = ?`).get(sessionId) as any;
    const seq = row.seq as number;
    this.db
      .prepare(`INSERT INTO blocks (session_id, seq, hex, length, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(sessionId, seq, hex, length, new Date().toISOString());
    return seq;
  }

  listBlocks(sessionId: number): BlockRow[] {
    const rows = this.db
      .prepare(`SELECT seq, hex, length, created_at FROM blocks WHERE session_id = ? ORDER BY seq`)
      .all(sessionId) as any[];
    return rows.map((r) => ({ seq: r.seq, hex: r.hex, length: r.length, createdAt: r.created_at }));
  }

  private mapSession(row: any): SessionRow {
    return {
      id: row.id,
      name: row.name,
      params: JSON.parse(row.params_json),
      presetName: row.preset_name,
      reg: row.reg >>> 0,
      length: row.length,
      finalized: row.finalized === 1,
      finalDigest: row.final_digest === null ? null : row.final_digest >>> 0,
      createdAt: row.created_at,
    };
  }
}
