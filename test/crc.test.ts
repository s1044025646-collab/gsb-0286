import { test } from "node:test";
import assert from "node:assert/strict";
import { CrcCore, CrcParams, crcOnce, reflect, validateParams, CrcError } from "../src/crc";
import { PRESETS } from "../src/presets";

/**
 * 独立参考实现：与 src/crc.ts 不共用任何代码路径。
 * refin=true 时使用 LSB-first + 反射多项式；refin=false 时使用朴素 MSB-first。
 * 仅用于 refin==refout 的参数组合（覆盖全部四个预设）。
 */
function referenceCrc(p: CrcParams, bytes: number[]): number {
  const mask = p.width === 32 ? 0xffffffff : (1 << p.width) - 1;
  let reg: number;
  if (p.refin) {
    let rpoly = 0;
    for (let i = 0; i < p.width; i++) rpoly = (rpoly << 1) | ((p.polynomial >>> i) & 1);
    reg = p.init;
    for (const b of bytes) {
      reg = (reg ^ b) >>> 0;
      for (let i = 0; i < 8; i++) {
        reg = reg & 1 ? ((reg >>> 1) ^ rpoly) >>> 0 : reg >>> 1;
      }
    }
  } else {
    reg = p.init;
    const msb = p.width === 32 ? 0x80000000 : 1 << (p.width - 1);
    for (const b of bytes) {
      for (let i = 7; i >= 0; i--) {
        const bit = (b >>> i) & 1;
        const top = ((reg & msb) !== 0 ? 1 : 0) ^ bit;
        reg = ((reg << 1) & mask) >>> 0;
        if (top === 1) reg = (reg ^ p.polynomial) >>> 0;
      }
    }
  }
  return ((reg ^ p.xorout) & mask) >>> 0;
}

const ascii = (s: string) => Array.from(Buffer.from(s, "ascii"));

test("四个预设的标准检查值 123456789", () => {
  const expected: Record<string, number> = {
    "CRC-8/SMBUS": 0xf4,
    "CRC-16/ARC": 0xbb3d,
    "CRC-16/CCITT-FALSE": 0x29b1,
    "CRC-32/ISO-HDLC": 0xcbf43926,
  };
  for (const [name, check] of Object.entries(expected)) {
    const got = crcOnce(PRESETS[name], new Uint8Array(ascii("123456789")));
    assert.equal(got, check, `${name}: 期望 0x${check.toString(16)}，得到 0x${got.toString(16)}`);
  }
});

test("与独立参考实现交叉核对（含 00 与 FF 的随机数据）", () => {
  const data: number[] = [0x00, 0xff, 0x00, 0x00, 0xff, 0x5a, 0xa5];
  let seed = 42;
  for (let i = 0; i < 200; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data.push(seed % 256);
  }
  for (const p of Object.values(PRESETS)) {
    assert.equal(crcOnce(p, new Uint8Array(data)), referenceCrc(p, data), p.width.toString());
  }
});

test("空输入语义：摘要 = init 收尾后的值", () => {
  assert.equal(crcOnce(PRESETS["CRC-8/SMBUS"], new Uint8Array()), 0x00);
  assert.equal(crcOnce(PRESETS["CRC-16/ARC"], new Uint8Array()), 0x0000);
  assert.equal(crcOnce(PRESETS["CRC-16/CCITT-FALSE"], new Uint8Array()), 0xffff);
  assert.equal(crcOnce(PRESETS["CRC-32/ISO-HDLC"], new Uint8Array()), 0x00000000);
});

test("手算例子：CRC-8/SMBUS 单字节 0x01 -> 0x07", () => {
  // 手算：reg=0x00，输入位 00000001，前 7 次移位最高位弹出 0，
  // 最后一次弹出 1，异或多项式 0x07，结果 0x07。
  assert.equal(crcOnce(PRESETS["CRC-8/SMBUS"], new Uint8Array([0x01])), 0x07);
  const core = new CrcCore(PRESETS["CRC-8/SMBUS"]);
  core.update(new Uint8Array([0x01, 0x00]));
  assert.equal(core.digest(), referenceCrc(PRESETS["CRC-8/SMBUS"], [0x01, 0x00]));
});

test("reflect 基础性质", () => {
  assert.equal(reflect(0x01, 8), 0x80);
  assert.equal(reflect(0x04c11db7, 32), 0xedb88320);
  assert.equal(reflect(reflect(0xdeadbeef, 32), 32), 0xdeadbeef);
});

test("32 位无符号输出：最高位为 1 时不是负数", () => {
  const v = crcOnce(PRESETS["CRC-32/ISO-HDLC"], new Uint8Array(ascii("123456789")));
  assert.equal(v, 0xcbf43926);
  assert.ok(v > 0x7fffffff, "应大于有符号 32 位最大值");
  assert.ok(Number.isInteger(v) && v >= 0);
});

test("分块方式不影响结果", () => {
  const data = new Uint8Array(ascii("123456789"));
  const once = crcOnce(PRESETS["CRC-32/ISO-HDLC"], data);
  for (const split of [[1, 1, 1, 1, 1, 1, 1, 1, 1], [2, 3, 4], [9], [5, 1, 3]]) {
    const core = new CrcCore(PRESETS["CRC-32/ISO-HDLC"]);
    let off = 0;
    for (const n of split) {
      core.update(data.slice(off, off + n));
      off += n;
    }
    assert.equal(core.digest(), once, `分块 ${split}`);
  }
});

test("读取摘要后继续追加与一次性一致", () => {
  const data = new Uint8Array(ascii("123456789"));
  const core = new CrcCore(PRESETS["CRC-16/ARC"]);
  core.update(data.slice(0, 4));
  const mid = core.digest();
  const regBefore = core.reg;
  core.update(data.slice(4));
  assert.equal(core.digest(), crcOnce(PRESETS["CRC-16/ARC"], data));
  assert.notEqual(core.reg, regBefore);
  assert.equal(typeof mid, "number");
});

test("参数越界与非法参数被拒绝", () => {
  const base = { width: 8, polynomial: 7, init: 0, refin: false, refout: false, xorout: 0 };
  assert.throws(() => validateParams({ ...base, width: 7 }), (e: CrcError) => e.code === "PARAM_OUT_OF_RANGE");
  assert.throws(() => validateParams({ ...base, polynomial: 0x1ff }), (e: CrcError) => e.code === "PARAM_OUT_OF_RANGE");
  assert.throws(() => validateParams({ ...base, width: 16, polynomial: 0x8005, xorout: 0x1ffff }), (e: CrcError) => e.code === "PARAM_OUT_OF_RANGE");
  assert.throws(() => validateParams({ ...base, width: 32, polynomial: 0x104c11db7 }), (e: CrcError) => e.code === "PARAM_OUT_OF_RANGE");
  assert.throws(() => validateParams({ ...base, polynomial: "xyz" }), (e: CrcError) => e.code === "PARAM_INVALID");
  const p = validateParams({ width: "8", polynomial: "0x07", init: "0x00", refin: "false", refout: "false", xorout: "0x00" });
  assert.deepEqual(p, PRESETS["CRC-8/SMBUS"]);
});

test("逐位解释内容正确（CRC-8/SMBUS, 0x01）", () => {
  const core = new CrcCore(PRESETS["CRC-8/SMBUS"]);
  const { traces } = core.update(new Uint8Array([0x01]), 1);
  assert.equal(traces.length, 1);
  const t = traces[0];
  assert.equal(t.regBefore, 0x00);
  assert.equal(t.inputByte, 0x01);
  assert.equal(t.bits.length, 8);
  assert.ok(t.bits.slice(0, 7).every((b) => !b.xorPoly));
  assert.ok(t.bits[7].xorPoly);
  assert.equal(t.regAfter, 0x07);
});
