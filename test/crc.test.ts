import { test } from "node:test";
import assert from "node:assert/strict";
import { CrcState, computeCrc } from "../src/crc";
import { PRESETS, parseHex, resolveParams, ApiError } from "../src/params";
import { referenceCrc } from "./reference";

const CHECK = Buffer.from("123456789", "ascii");

test("标准检查值: 123456789", () => {
  assert.equal(computeCrc(PRESETS["CRC-8/SMBUS"], CHECK), 0xf4);
  assert.equal(computeCrc(PRESETS["CRC-16/ARC"], CHECK), 0xbb3d);
  assert.equal(computeCrc(PRESETS["CRC-16/CCITT-FALSE"], CHECK), 0x29b1);
  assert.equal(computeCrc(PRESETS["CRC-32/ISO-HDLC"], CHECK), 0xcbf43926);
});

test("与独立参考实现交叉核对（含随机数据）", () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (const p of Object.values(PRESETS)) {
    for (let t = 0; t < 20; t++) {
      const bytes = new Uint8Array(rand() % 64).map(() => rand() & 0xff);
      assert.equal(computeCrc(p, bytes), referenceCrc(p, bytes), `width=${p.width}`);
    }
  }
});

test("手算例子: CRC-8/SMBUS 单字节 0x01 = 0x07", () => {
  // 手算：reg=0^0x01=0x01；前 7 次移位无进位得 0x80；第 8 次移出最高位，异或 0x07 -> 0x07
  assert.equal(computeCrc(PRESETS["CRC-8/SMBUS"], new Uint8Array([0x01])), 0x07);
});

test("空输入返回 init 收尾值", () => {
  assert.equal(computeCrc(PRESETS["CRC-8/SMBUS"], new Uint8Array(0)), 0x00);
  assert.equal(computeCrc(PRESETS["CRC-16/CCITT-FALSE"], new Uint8Array(0)), 0xffff);
  assert.equal(computeCrc(PRESETS["CRC-32/ISO-HDLC"], new Uint8Array(0)), 0x00000000);
});

test("包含 00 与 FF 的数据", () => {
  const data = new Uint8Array([0x00, 0xff, 0x00, 0x00, 0xff]);
  for (const p of Object.values(PRESETS)) {
    assert.equal(computeCrc(p, data), referenceCrc(p, data));
  }
});

test("不同分块方式结果一致", () => {
  const data = new Uint8Array(257).map((_, i) => i & 0xff);
  for (const p of Object.values(PRESETS)) {
    const oneShot = computeCrc(p, data);
    for (const chunk of [1, 7, 64, 256]) {
      const s = new CrcState(p);
      for (let i = 0; i < data.length; i += chunk) s.update(data.slice(i, i + chunk));
      assert.equal(s.digest(), oneShot, `width=${p.width} chunk=${chunk}`);
    }
  }
});

test("读取摘要后继续追加与一次性一致", () => {
  const p = PRESETS["CRC-32/ISO-HDLC"];
  const s = new CrcState(p);
  s.update(new Uint8Array([0x31, 0x32, 0x33]));
  assert.equal(s.digest(), computeCrc(p, new Uint8Array([0x31, 0x32, 0x33])));
  s.update(new Uint8Array([0x34, 0x35]));
  assert.equal(s.digest(), computeCrc(p, new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35])));
});

test("32 位无符号输出（最高位为 1 不为负）", () => {
  const d = computeCrc(PRESETS["CRC-32/ISO-HDLC"], CHECK);
  assert.ok(d > 0 && d <= 0xffffffff);
  assert.equal(d, 0xcbf43926);
});

test("参数越界与非法宽度被拒绝", () => {
  assert.throws(() => resolveParams({ width: 7, poly: 1, init: 0, xorout: 0 }), ApiError);
  assert.throws(() => resolveParams({ width: 8, poly: 0x1ff, init: 0, xorout: 0 }), /超出/);
  assert.throws(() => resolveParams({ width: 16, poly: 0x07, init: 0x1ffff, xorout: 0 }), /超出/);
  assert.throws(() => resolveParams({ width: 32, poly: "0x104c11db7", init: 0, xorout: 0 }), /超出/);
  assert.throws(() => resolveParams({ preset: "NOPE" }), /未知预设/);
});

test("非法十六进制在消耗前拒绝", () => {
  assert.throws(() => parseHex("0g"), /非十六进制/);
  assert.throws(() => parseHex("abc"), /奇数/);
  assert.throws(() => parseHex(123 as any), /字符串/);
  assert.deepEqual([...parseHex("")], []);
});
