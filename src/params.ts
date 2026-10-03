import { CrcParams, CrcWidth, maskFor } from "./crc";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const PRESETS: Record<string, CrcParams> = {
  "CRC-8/SMBUS": { width: 8, poly: 0x07, init: 0x00, refin: false, refout: false, xorout: 0x00 },
  "CRC-16/ARC": { width: 16, poly: 0x8005, init: 0x0000, refin: true, refout: true, xorout: 0x0000 },
  "CRC-16/CCITT-FALSE": { width: 16, poly: 0x1021, init: 0xffff, refin: false, refout: false, xorout: 0x0000 },
  "CRC-32/ISO-HDLC": { width: 32, poly: 0x04c11db7, init: 0xffffffff, refin: true, refout: true, xorout: 0xffffffff },
};

function parseHexOrNumber(value: unknown, name: string, width: CrcWidth): number {
  const mask = maskFor(width);
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const s = value.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]+$/.test(s)) {
      throw new ApiError("PARAM_INVALID", `参数 ${name} 不是合法十六进制: ${value}`);
    }
    n = parseInt(s, 16);
  } else {
    throw new ApiError("PARAM_INVALID", `参数 ${name} 类型非法`);
  }
  if (!Number.isInteger(n) || n < 0 || n > mask) {
    throw new ApiError(
      "PARAM_OUT_OF_RANGE",
      `参数 ${name}=0x${n.toString(16)} 超出 ${width} 位范围 (最大 0x${mask.toString(16)})`,
    );
  }
  return n >>> 0;
}

/** 解析并校验用户参数；preset 仅作为初值，真实参数始终完整记录 */
export function resolveParams(input: any): CrcParams {
  if (input == null || typeof input !== "object") {
    throw new ApiError("PARAM_INVALID", "请求体须为参数对象");
  }
  let base: Partial<CrcParams> = {};
  if (input.preset !== undefined) {
    const preset = PRESETS[input.preset];
    if (!preset) throw new ApiError("PRESET_UNKNOWN", `未知预设: ${input.preset}`, 404);
    base = { ...preset };
  }
  const width = (input.width ?? base.width) as CrcWidth;
  if (width !== 8 && width !== 16 && width !== 32) {
    throw new ApiError("WIDTH_UNSUPPORTED", `仅支持宽度 8/16/32，收到: ${input.width}`);
  }
  const boolOf = (v: unknown, dflt: boolean, name: string): boolean => {
    if (v === undefined) return dflt;
    if (typeof v !== "boolean") throw new ApiError("PARAM_INVALID", `参数 ${name} 须为布尔值`);
    return v;
  };
  return {
    width,
    poly: parseHexOrNumber(input.poly ?? base.poly, "poly", width),
    init: parseHexOrNumber(input.init ?? base.init, "init", width),
    refin: boolOf(input.refin, base.refin ?? false, "refin"),
    refout: boolOf(input.refout, base.refout ?? false, "refout"),
    xorout: parseHexOrNumber(input.xorout ?? base.xorout, "xorout", width),
  };
}

export const MAX_HEX_LENGTH = 2 * 1024 * 1024; // 单块最大 1 MiB

/** 严格校验十六进制输入；任何非法都在消耗数据前拒绝 */
export function parseHex(hex: unknown): Uint8Array {
  if (typeof hex !== "string") {
    throw new ApiError("INVALID_HEX", "hex 字段须为字符串");
  }
  const s = hex.trim();
  if (s.length === 0) return new Uint8Array(0); // 空块：合法，不推进状态
  if (s.length % 2 !== 0) {
    throw new ApiError("ODD_LENGTH", `十六进制长度为奇数 (${s.length})`);
  }
  if (!/^[0-9a-fA-F]+$/.test(s)) {
    throw new ApiError("INVALID_HEX", "包含非十六进制字符");
  }
  if (s.length > MAX_HEX_LENGTH) {
    throw new ApiError("INPUT_TOO_LARGE", `单块超过 ${MAX_HEX_LENGTH / 2} 字节上限`, 413);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function toHex(value: number, width: CrcWidth): string {
  return value.toString(16).toUpperCase().padStart(width / 4, "0");
}
