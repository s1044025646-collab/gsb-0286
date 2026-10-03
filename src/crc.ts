/**
 * 逐位参数化 CRC 核心。
 *
 * 算法模型（MSB-first 正规形式）：
 *   1. 若 refin=true，先把每个输入字节做 8 位反射；
 *   2. 对每个输入位（高位优先）：将输入位与寄存器移出的最高位异或得到 top，
 *      reg = (reg << 1) & mask；若 top=1 则 reg ^= polynomial；
 *   3. 输出时（且仅在读取摘要时，在寄存器副本上）：
 *      若 refout=true，对寄存器做 width 位反射，最后异或 xorout。
 *
 * 多项式始终以“省略最高次项的正常（非反射）形式”给出，例如
 * CRC-32/ISO-HDLC 使用 0x04C11DB7 而不是 0xEDB88320。
 * 反射只发生在输入字节（refin）与输出寄存器（refout）上，
 * 不会对多项式做反射，因此不存在“既反射多项式又反射结果”的重复。
 *
 * 所有中间值都通过 mask 限制在 width 位内，并用 >>> 0 归一化为
 * 无符号数，32 位最高位为 1 时不会输出负数。
 */

export type CrcWidth = 8 | 16 | 32;

export interface CrcParams {
  width: CrcWidth;
  /** 多项式，省略最高次项，正常（非反射）形式，必须落在 width 位内 */
  polynomial: number;
  /** 寄存器初始值，width 位内 */
  init: number;
  /** 是否反射每个输入字节 */
  refin: boolean;
  /** 是否在输出时反射寄存器 */
  refout: boolean;
  /** 最终异或值，width 位内 */
  xorout: number;
}

export class CrcError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "CrcError";
  }
}

export function maskFor(width: CrcWidth): number {
  return width === 32 ? 0xffffffff : (1 << width) - 1;
}

/** 将 value 的低 bits 位做位序反射，返回无符号数。 */
export function reflect(value: number, bits: number): number {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | ((value >>> i) & 1);
  }
  return result >>> 0;
}

function parseIntParam(name: string, raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  throw new CrcError("PARAM_INVALID", `参数 ${name} 必须是整数或十六进制字符串，收到: ${JSON.stringify(raw)}`);
}

function parseBoolParam(name: string, raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === 1 || raw === "1") return true;
  if (raw === "false" || raw === 0 || raw === "0") return false;
  throw new CrcError("PARAM_INVALID", `参数 ${name} 必须是布尔值，收到: ${JSON.stringify(raw)}`);
}

/** 校验并规范化参数；任何越界都在此拒绝。 */
export function validateParams(raw: Record<string, unknown>): CrcParams {
  const widthRaw = parseIntParam("width", raw.width);
  if (widthRaw !== 8 && widthRaw !== 16 && widthRaw !== 32) {
    throw new CrcError("PARAM_OUT_OF_RANGE", `width 只支持 8/16/32，收到: ${widthRaw}`);
  }
  const width = widthRaw as CrcWidth;
  const mask = maskFor(width);
  const checkRange = (name: string): number => {
    const v = parseIntParam(name, raw[name]);
    if (v < 0 || v > mask) {
      throw new CrcError(
        "PARAM_OUT_OF_RANGE",
        `参数 ${name}=0x${v < 0 ? "-" : ""}${Math.abs(v).toString(16)} 超出 ${width} 位范围 (0..0x${mask.toString(16)})`
      );
    }
    return v >>> 0;
  };
  return {
    width,
    polynomial: checkRange("polynomial"),
    init: checkRange("init"),
    refin: parseBoolParam("refin", raw.refin),
    refout: parseBoolParam("refout", raw.refout),
    xorout: checkRange("xorout"),
  };
}

export interface BitStep {
  /** 该字节内的位序号，7 为最高位 */
  bitIndex: number;
  /** 反射处理后的输入位 */
  inputBit: number;
  /** 移位前寄存器最高位是否为 1（即是否异或多项式） */
  xorPoly: boolean;
  /** 该位处理后的寄存器值（无符号） */
  regAfter: number;
}

export interface ByteTrace {
  /** 全局字节序号（从 0 开始） */
  byteIndex: number;
  /** 处理前寄存器 */
  regBefore: number;
  /** 原始输入字节 */
  inputByte: number;
  /** refin 反射后的有效字节 */
  effectiveByte: number;
  bits: BitStep[];
  /** 该字节处理后的寄存器 */
  regAfter: number;
}

export class CrcCore {
  readonly mask: number;
  private readonly msb: number;
  /** 内部未收尾寄存器（未反射、未异或 xorout） */
  reg: number;
  /** 已处理字节数 */
  length: number;

  constructor(public readonly params: CrcParams, reg?: number, length?: number) {
    this.mask = maskFor(params.width);
    this.msb = params.width === 32 ? 0x80000000 : 1 << (params.width - 1);
    this.reg = (reg === undefined ? params.init : reg) >>> 0;
    this.length = length === undefined ? 0 : length;
  }

  /** 更新一个字节；trace 非 null 时记录逐位过程。 */
  updateByte(byte: number, trace: ByteTrace[] | null): void {
    const effective = this.params.refin ? reflect(byte, 8) : byte;
    const record = trace !== null;
    let steps: BitStep[] | null = record ? [] : null;
    const regBefore = this.reg;
    for (let i = 7; i >= 0; i--) {
      const bit = (effective >>> i) & 1;
      const top = ((this.reg & this.msb) !== 0 ? 1 : 0) ^ bit;
      this.reg = ((this.reg << 1) & this.mask) >>> 0;
      if (top) this.reg = (this.reg ^ this.params.polynomial) >>> 0;
      if (steps) steps.push({ bitIndex: i, inputBit: bit, xorPoly: top === 1, regAfter: this.reg });
    }
    if (steps) {
      trace!.push({
        byteIndex: this.length,
        regBefore,
        inputByte: byte,
        effectiveByte: effective,
        bits: steps,
        regAfter: this.reg,
      });
    }
    this.length++;
  }

  update(bytes: Uint8Array, traceLimit = 0): { traces: ByteTrace[]; tracedBytes: number } {
    const traces: ByteTrace[] = [];
    let traced = 0;
    for (const b of bytes) {
      const want = traced < traceLimit;
      this.updateByte(b, want ? traces : null);
      if (want) traced++;
    }
    return { traces, tracedBytes: traced };
  }

  /**
   * 在当前寄存器的“概念副本”上计算摘要，绝不写回内部状态，
   * 因此读取摘要后继续追加与一次性校验结果一致。
   */
  digest(): number {
    const r = this.params.refout ? reflect(this.reg, this.params.width) : this.reg;
    return ((r ^ this.params.xorout) & this.mask) >>> 0;
  }
}

/** 一次性计算（与分块共用同一 CrcCore 语义）。 */
export function crcOnce(params: CrcParams, bytes: Uint8Array): number {
  const core = new CrcCore(params);
  core.update(bytes);
  return core.digest();
}

export function toHex(value: number, width: CrcWidth): string {
  return "0x" + (value >>> 0).toString(16).toUpperCase().padStart(width / 4, "0");
}
