import { CrcParams, CrcState, reflect, BitStep } from "./crc";
import { toHex } from "./params";

export interface ByteTrace {
  byteIndex: number;
  inputByte: string;
  effectiveByte: string;
  regBefore: string;
  steps: BitStep[];
  regAfter: string;
}

export interface Explanation {
  totalBytes: number;
  tracedBytes: number;
  omitted: { from: number; to: number } | null;
  note: string;
  bytes: ByteTrace[];
}

/**
 * 逐位解释：展示每字节处理前寄存器、每个输入位、是否异或多项式、处理后值。
 * 超过 maxBytes 时只追踪前 maxBytes 字节，并标明省略范围。
 */
export function explain(params: CrcParams, bytes: Uint8Array, maxBytes = 16): Explanation {
  const state = new CrcState(params);
  const width = params.width;
  const traces: ByteTrace[] = [];
  const traced = Math.min(bytes.length, maxBytes);
  for (let i = 0; i < traced; i++) {
    const regBefore = state.register;
    const steps = state.updateByte(bytes[i]);
    traces.push({
      byteIndex: i,
      inputByte: "0x" + bytes[i].toString(16).toUpperCase().padStart(2, "0"),
      effectiveByte:
        "0x" + (params.refin ? reflect(bytes[i], 8) : bytes[i]).toString(16).toUpperCase().padStart(2, "0"),
      regBefore: "0x" + toHex(regBefore, width),
      steps,
      regAfter: "0x" + toHex(state.register, width),
    });
  }
  if (bytes.length > traced) {
    state.update(bytes.slice(traced));
  }
  return {
    totalBytes: bytes.length,
    tracedBytes: traced,
    omitted: bytes.length > traced ? { from: traced, to: bytes.length - 1 } : null,
    note: "regBefore/regAfter 为未收尾内部寄存器；digest 需按 refout/xorout 收尾。",
    bytes: traces,
  };
}
