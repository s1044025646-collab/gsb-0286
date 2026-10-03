/**
 * 独立参考实现：与 src/crc.ts 不同 formulation。
 * 反射型采用“反射多项式 + LSB-first”的经典写法，
 * 非反射型用 MSB-first，用于交叉核对主实现，避免只比较同一调用路径。
 */
import { CrcParams, maskFor, reflect } from "../src/crc";

export function referenceCrc(params: CrcParams, bytes: Uint8Array): number {
  const mask = maskFor(params.width);
  let reg = params.init & mask;
  if (params.refin) {
    const rpoly = reflect(params.poly, params.width);
    for (const b of bytes) {
      reg ^= b;
      for (let i = 0; i < 8; i++) {
        reg = reg & 1 ? (reg >>> 1) ^ rpoly : reg >>> 1;
        reg &= mask;
      }
    }
    const out = params.refout ? reg : reflect(reg, params.width);
    return ((out ^ params.xorout) & mask) >>> 0;
  }
  const top = params.width === 32 ? 0x80000000 : 1 << (params.width - 1);
  for (const b of bytes) {
    reg = (reg ^ (b << (params.width - 8))) & mask;
    for (let i = 0; i < 8; i++) {
      reg = reg & top ? ((reg << 1) ^ params.poly) & mask : (reg << 1) & mask;
    }
  }
  const out = params.refout ? reflect(reg, params.width) : reg;
  return ((out ^ params.xorout) & mask) >>> 0;
}
