import { randomUUID } from "node:crypto";
import { CrcParams, CrcState, maskFor } from "./crc";
import { ApiError, parseHex, toHex } from "./params";
import { Store, SessionRow } from "./db";

export interface DigestView {
  sessionId: string;
  digestHex: string;
  digest: number;
  length: number;
  finalized: boolean;
  params: CrcParams;
}

export class SessionService {
  constructor(private store: Store) {}

  create(params: CrcParams): SessionRow {
    const id = randomUUID();
    this.store.createSession(id, params);
    return this.store.getSession(id)!;
  }

  private load(id: string): { row: SessionRow; state: CrcState } {
    const row = this.store.getSession(id);
    if (!row) throw new ApiError("SESSION_NOT_FOUND", `会话不存在: ${id}`, 404);
    const state = new CrcState(row.params, row.reg, row.length);
    return { row, state };
  }

  /** 追加块：先完整校验 hex，全部失败则状态不变；空块合法但不推进状态 */
  append(id: string, hex: unknown): DigestView {
    const { row, state } = this.load(id);
    if (row.finalized) {
      throw new ApiError("SESSION_FINALIZED", "会话已结束，拒绝追加", 409);
    }
    const bytes = parseHex(hex); // 校验失败时抛出，状态未变
    if (bytes.length > 0) {
      state.update(bytes);
      const seq = this.store.blockCount(id);
      this.store.appendBlock(id, seq, (hex as string).trim(), state.register, state.length);
    }
    return this.digestView(row, state);
  }

  /** 读取摘要：基于寄存器副本，不写回 final xor/反射 */
  digest(id: string): DigestView {
    const { row, state } = this.load(id);
    return this.digestView(row, state);
  }

  finalize(id: string): DigestView {
    const { row, state } = this.load(id);
    if (!row.finalized) {
      const d = state.digest();
      this.store.finalizeSession(id, d);
      row.finalized = true;
      row.finalDigest = d;
    }
    return this.digestView(row, state);
  }

  report(id: string) {
    const { row, state } = this.load(id);
    const p = row.params;
    return {
      sessionId: row.id,
      createdAt: row.createdAt,
      params: {
        width: p.width,
        poly: "0x" + toHex(p.poly, p.width),
        init: "0x" + toHex(p.init, p.width),
        refin: p.refin,
        refout: p.refout,
        xorout: "0x" + toHex(p.xorout, p.width),
      },
      registerHex: "0x" + toHex(state.register, p.width),
      length: row.length,
      finalized: row.finalized,
      digestHex: "0x" + toHex(row.finalized && row.finalDigest !== null ? row.finalDigest : state.digest(), p.width),
      blocks: this.store.listBlocks(id),
      note: "CRC 仅用于差错检测；摘要相同不代表数据一定相同。",
    };
  }

  private digestView(row: SessionRow, state: CrcState): DigestView {
    const d = row.finalized && row.finalDigest !== null ? row.finalDigest : state.digest();
    return {
      sessionId: row.id,
      digest: d,
      digestHex: toHex(d, row.params.width),
      length: row.length,
      finalized: row.finalized,
      params: row.params,
    };
  }
}

export { maskFor };
