/**
 * 逐位 CRC 状态更新器（基准实现）。
 *
 * 算法约定（Rocksoft 模型的逐字节形式）：
 *  - 输入：若 refin 为 true，先逐字节反转每个输入字节（8 位反射）。
 *  - 移位：始终以“最高位优先（MSB-first）”方式，使用未反射的多项式 poly
 *    （省略最高次项）做 8 次移位/异或。
 *  - 输出：digest 时，若 refout 为 true 则对整个寄存器做 width 位反射，
 *    然后异或 xorout。多项式始终不反射，反射只发生在输入字节与最终寄存器上，
 *    不会既反射多项式又重复反射结果。
 *  - 每轮更新都用 mask 限制在 width 位内；32 位时通过 >>> 0 保证无符号输出。
 */

export type CrcWidth = 8 | 16 | 32;

export interface CrcParams {
  width: CrcWidth;
  /** 多项式，省略最高次项，十六进制字符串或数字，须在 width 位内 */
  poly: number;
  init: number;
  refin: boolean;
  refout: boolean;
  xorout: number;
}

export function maskFor(width: CrcWidth): number {
  return width === 32 ? 0xffffffff : (1 << width) - 1;
}

export function topBitFor(width: CrcWidth): number {
  return width === 32 ? 0x80000000 : 1 << (width - 1);
}

/** 反射 value 的低 bits 位 */
export function reflect(value: number, bits: number): number {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    if (value & (1 << i)) result |= 1 << (bits - 1 - i);
  }
  return result >>> 0;
}

export class CrcState {
  readonly params: CrcParams;
  private readonly mask: number;
  private readonly topBit: number;
  /** 内部寄存器：未收尾（未反射、未 xorout）的原始状态 */
  private reg: number;
  /** 已处理字节数 */
  length = 0;

  constructor(params: CrcParams, reg?: number, length?: number) {
    this.params = params;
    this.mask = maskFor(params.width);
    this.topBit = topBitFor(params.width);
    this.reg = (reg === undefined ? params.init : reg) & this.mask;
    this.length = length ?? 0;
  }

  /** 当前内部寄存器（未收尾） */
  get register(): number {
    return this.reg >>> 0;
  }

  /** 更新一个字节，返回逐步轨迹（供解释接口使用） */
  updateByte(inputByte: number): BitStep[] {
    const byte = this.params.refin ? reflect(inputByte, 8) : inputByte;
    const steps: BitStep[] = [];
    this.reg = ((this.reg ^ (byte << (this.params.width - 8))) & this.mask) >>> 0;
    for (let i = 0; i < 8; i++) {
      const before = this.reg >>> 0;
      const topSet = (this.reg & this.topBit) !== 0;
      this.reg = (this.reg << 1) & this.mask;
      if (topSet) this.reg = (this.reg ^ this.params.poly) & this.mask;
      this.reg = this.reg >>> 0;
      steps.push({
        bitIndex: i,
        inputBit: (byte >> (7 - i)) & 1,
        regBefore: before,
        xorPoly: topSet,
        regAfter: this.reg,
      });
    }
    this.length += 1;
    return steps;
  }

  update(bytes: Uint8Array): void {
    for (const b of bytes) this.updateByte(b);
  }

  /**
   * 基于当前寄存器副本计算摘要，不修改内部状态，
   * 因此读取摘要后继续追加与一次性校验结果一致。
   */
  digest(): number {
    let r = this.reg;
    if (this.params.refout) {
      r = reflect(r, this.params.width);
    }
    return ((r ^ this.params.xorout) & this.mask) >>> 0;
  }
}

export interface BitStep {
  bitIndex: number;
  inputBit: number;
  regBefore: number;
  xorPoly: boolean;
  regAfter: number;
}

export function computeCrc(params: CrcParams, bytes: Uint8Array): number {
  const state = new CrcState(params);
  state.update(bytes);
  return state.digest();
}
