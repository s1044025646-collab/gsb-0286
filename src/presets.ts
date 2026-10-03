import { CrcParams } from "./crc";

/** 内置预设。预设只是参数的便利别名，落库时永远记录真实参数快照。 */
export const PRESETS: Record<string, CrcParams> = {
  "CRC-8/SMBUS": { width: 8, polynomial: 0x07, init: 0x00, refin: false, refout: false, xorout: 0x00 },
  "CRC-16/ARC": { width: 16, polynomial: 0x8005, init: 0x0000, refin: true, refout: true, xorout: 0x0000 },
  "CRC-16/CCITT-FALSE": { width: 16, polynomial: 0x1021, init: 0xffff, refin: false, refout: false, xorout: 0x0000 },
  "CRC-32/ISO-HDLC": { width: 32, polynomial: 0x04c11db7, init: 0xffffffff, refin: true, refout: true, xorout: 0xffffffff },
};

export function getPreset(name: string): CrcParams | undefined {
  const p = PRESETS[name.toUpperCase()] ?? PRESETS[name];
  if (!p) {
    const hit = Object.keys(PRESETS).find((k) => k.toUpperCase() === name.toUpperCase());
    return hit ? { ...PRESETS[hit] } : undefined;
  }
  return { ...p };
}
