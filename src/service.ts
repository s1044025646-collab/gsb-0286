import {
  ByteTrace,
  CrcCore,
  CrcError,
  CrcParams,
  crcOnce,
  toHex,
  validateParams,
} from "./crc";
import { getPreset } from "./presets";
import { SessionRow, Store } from "./store";

/** 单个块允许的最大字节数（防止超限输入拖垮服务） */
export const MAX_BLOCK_BYTES = 1024 * 1024;
/** 逐位解释默认最多展示的字节数 */
export const DEFAULT_TRACE_MAX_BYTES = 16;
export const TRACE_MAX_BYTES_LIMIT = 256;

/** 把十六进制字符串解析为字节；任何非法输入在消耗前整体拒绝。 */
export function parseHex(hex: unknown): Uint8Array {
  if (typeof hex !== "string") {
    throw new CrcError("INVALID_HEX", "hex 字段必须是字符串");
  }
  const s = hex.trim().replace(/^0x/i, "").replace(/[\s_-]/g, "");
  if (s.length % 2 !== 0) {
    throw new CrcError("ODD_LENGTH", `十六进制长度必须为偶数，当前有效长度 ${s.length}`);
  }
  if (!/^[0-9a-fA-F]*$/.test(s)) {
    throw new CrcError("INVALID_HEX", "包含非十六进制字符");
  }
  const bytes = new Uint8Array(s.length / 2);
  if (bytes.length > MAX_BLOCK_BYTES) {
    throw new CrcError("INPUT_TOO_LARGE", `单块最大 ${MAX_BLOCK_BYTES} 字节，收到 ${bytes.length}`);
  }
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function resolveParams(input: { preset?: string; params?: Record<string, unknown> }): {
  params: CrcParams;
  presetName: string | null;
} {
  if (input.params) {
    return { params: validateParams(input.params), presetName: null };
  }
  if (input.preset) {
    const p = getPreset(input.preset);
    if (!p) throw new CrcError("UNKNOWN_PRESET", `未知预设: ${input.preset}`);
    return { params: p, presetName: input.preset };
  }
  throw new CrcError("PARAM_INVALID", "必须提供 preset 或 params");
}

function digestView(params: CrcParams, value: number) {
  return { hex: toHex(value, params.width), unsigned: value >>> 0 };
}

export class CrcService {
  constructor(public readonly store: Store) {}

  createSession(input: { preset?: string; params?: Record<string, unknown>; name?: string }) {
    const { params, presetName } = resolveParams(input);
    const row = this.store.createSession(input.name ?? null, params, presetName);
    return this.sessionView(row);
  }

  private mustGet(id: number): SessionRow {
    const row = this.store.getSession(id);
    if (!row) throw new CrcError("NOT_FOUND", `会话 ${id} 不存在`);
    return row;
  }

  /**
   * 追加一个块。先完整校验 hex，再一次性更新寄存器并落库；
   * 校验失败时状态完全不变。空块是合法 no-op（不消耗、不记录）。
   */
  appendBlock(id: number, hex: unknown) {
    const row = this.mustGet(id);
    if (row.finalized) throw new CrcError("SESSION_FINALIZED", `会话 ${id} 已结束，拒绝追加`);
    const bytes = parseHex(hex);
    if (bytes.length === 0) {
      return { ...this.sessionView(row), blockBytes: 0, note: "空块为 no-op，未改变状态" };
    }
    const core = new CrcCore(row.params, row.reg, row.length);
    core.update(bytes);
    const hexNorm = Buffer.from(bytes).toString("hex").toUpperCase();
    const seq = this.store.appendBlock(id, hexNorm, bytes.length);
    this.store.updateState(id, core.reg, core.length);
    return { ...this.sessionView(this.mustGet(id)), blockBytes: bytes.length, blockSeq: seq };
  }

  /** 读取当前摘要；在寄存器副本上计算，不影响内部状态。 */
  getDigest(id: number) {
    const row = this.mustGet(id);
    const core = new CrcCore(row.params, row.reg, row.length);
    const value = row.finalized && row.finalDigest !== null ? row.finalDigest : core.digest();
    return {
      sessionId: id,
      length: row.length,
      finalized: row.finalized,
      digest: digestView(row.params, value),
    };
  }

  finalize(id: number) {
    const row = this.mustGet(id);
    if (!row.finalized) {
      const core = new CrcCore(row.params, row.reg, row.length);
      this.store.finalize(id, core.digest());
    }
    return this.getDigest(id);
  }

  report(id: number) {
    const row = this.mustGet(id);
    const blocks = this.store.listBlocks(id);
    return {
      session: this.sessionView(row),
      digest: this.getDigest(id).digest,
      blocks: blocks.map((b) => ({ seq: b.seq, bytes: b.length, hex: b.hex, createdAt: b.createdAt })),
      disclaimer: "CRC 仅用于差错检测；CRC 相同不能证明数据一定相同。",
    };
  }

  /**
   * 逐位解释：从参数快照重放已记录的块，最多展示 maxBytes 个字节，
   * 超出部分标明省略范围。重放结果会与持久化寄存器做一致性校验。
   */
  trace(id: number, maxBytes = DEFAULT_TRACE_MAX_BYTES) {
    const row = this.mustGet(id);
    const limit = Math.max(0, Math.min(maxBytes, TRACE_MAX_BYTES_LIMIT));
    const blocks = this.store.listBlocks(id);
    const core = new CrcCore(row.params);
    const traces: ByteTrace[] = [];
    let traced = 0;
    for (const b of blocks) {
      const bytes = parseHex(b.hex);
      const remain = Math.max(0, limit - traced);
      const r = core.update(bytes, remain);
      traces.push(...r.traces);
      traced += r.tracedBytes;
    }
    if (core.reg !== row.reg || core.length !== row.length) {
      throw new CrcError("INTERNAL", "重放结果与持久化状态不一致");
    }
    const omitted = row.length - traced;
    return {
      sessionId: id,
      params: row.params,
      totalBytes: row.length,
      tracedBytes: traced,
      omittedBytes: omitted,
      omittedRange: omitted > 0 ? `字节 [${traced}, ${row.length}) 已省略` : null,
      bytes: traces,
    };
  }

  /** 一次性入口：与分块共用 CrcCore 语义。空输入合法，返回 init 收尾后的摘要。 */
  check(input: { preset?: string; params?: Record<string, unknown>; hex: unknown }) {
    const { params, presetName } = resolveParams(input);
    const bytes = parseHex(input.hex);
    const digest = crcOnce(params, bytes);
    return { preset: presetName, params, length: bytes.length, digest: digestView(params, digest) };
  }

  listSessions() {
    return this.store.listSessions().map((r) => this.sessionView(r));
  }

  private sessionView(row: SessionRow) {
    return {
      id: row.id,
      name: row.name,
      preset: row.presetName,
      params: row.params,
      register: toHex(row.reg, row.params.width),
      length: row.length,
      finalized: row.finalized,
      finalDigest: row.finalDigest !== null ? toHex(row.finalDigest, row.params.width) : null,
      createdAt: row.createdAt,
    };
  }
}
