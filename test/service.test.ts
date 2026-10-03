import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CrcError } from "../src/crc";
import { CrcService } from "../src/service";
import { Store } from "../src/store";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crc-test-"));
}

const HEX = "313233343536373839"; // ASCII "123456789"

test("会话分块 == 一次性；读取摘要后可继续", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const svc = new CrcService(store);
  const s = svc.createSession({ preset: "CRC-32/ISO-HDLC" });
  svc.appendBlock(s.id, HEX.slice(0, 6));
  const mid = svc.getDigest(s.id);
  assert.equal(mid.length, 3);
  svc.appendBlock(s.id, HEX.slice(6, 12));
  svc.appendBlock(s.id, HEX.slice(12));
  const fin = svc.finalize(s.id);
  assert.equal(fin.digest.unsigned, 0xcbf43926);
  assert.equal(fin.digest.hex, "0xCBF43926");
  const once = svc.check({ preset: "CRC-32/ISO-HDLC", hex: HEX });
  assert.equal(once.digest.unsigned, fin.digest.unsigned);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("持久化续算：重启（重开数据库）后继续追加", () => {
  const dir = tmpDir();
  let store = new Store(dir);
  let svc = new CrcService(store);
  const s = svc.createSession({ preset: "CRC-16/CCITT-FALSE" });
  svc.appendBlock(s.id, HEX.slice(0, 10));
  store.close();
  // 模拟重启
  store = new Store(dir);
  svc = new CrcService(store);
  const restored = svc.getDigest(s.id);
  assert.equal(restored.length, 5);
  svc.appendBlock(s.id, HEX.slice(10));
  const fin = svc.finalize(s.id);
  assert.equal(fin.digest.unsigned, 0x29b1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("参数快照：预设名不代替真实参数，恢复时不重读预设", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const svc = new CrcService(store);
  const s = svc.createSession({ preset: "CRC-8/SMBUS" });
  const row = store.getSession(s.id)!;
  assert.equal(row.presetName, "CRC-8/SMBUS");
  assert.deepEqual(row.params, { width: 8, polynomial: 7, init: 0, refin: false, refout: false, xorout: 0 });
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("失败不改变状态：非法 hex / 奇数长度 / 结束后追加", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const svc = new CrcService(store);
  const s = svc.createSession({ preset: "CRC-16/ARC" });
  svc.appendBlock(s.id, "00FF");
  const before = svc.getDigest(s.id);
  assert.throws(() => svc.appendBlock(s.id, "ZZ"), (e: CrcError) => e.code === "INVALID_HEX");
  assert.throws(() => svc.appendBlock(s.id, "ABC"), (e: CrcError) => e.code === "ODD_LENGTH");
  assert.throws(() => svc.appendBlock(s.id, 123 as any), (e: CrcError) => e.code === "INVALID_HEX");
  const after = svc.getDigest(s.id);
  assert.deepEqual(after, before); // 状态未被部分消耗
  svc.finalize(s.id);
  assert.throws(() => svc.appendBlock(s.id, "00"), (e: CrcError) => e.code === "SESSION_FINALIZED");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("空块为 no-op；空输入一次性校验合法", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const svc = new CrcService(store);
  const s = svc.createSession({ preset: "CRC-8/SMBUS" });
  const r = svc.appendBlock(s.id, "");
  assert.equal(r.blockBytes, 0);
  assert.equal(svc.getDigest(s.id).length, 0);
  assert.equal(store.listBlocks(s.id).length, 0);
  const once = svc.check({ preset: "CRC-8/SMBUS", hex: "" });
  assert.equal(once.digest.unsigned, 0x00);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("trace 限制长度并标明省略范围", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const svc = new CrcService(store);
  const s = svc.createSession({ preset: "CRC-8/SMBUS" });
  svc.appendBlock(s.id, HEX); // 9 字节
  const t = svc.trace(s.id, 3);
  assert.equal(t.tracedBytes, 3);
  assert.equal(t.totalBytes, 9);
  assert.equal(t.omittedBytes, 6);
  assert.match(t.omittedRange!, /\[3, 9\)/);
  assert.equal(t.bytes.length, 3);
  assert.equal(t.bytes[0].bits.length, 8);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("报告包含参数快照、块顺序与免责声明", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const svc = new CrcService(store);
  const s = svc.createSession({ preset: "CRC-32/ISO-HDLC", name: "r1" });
  svc.appendBlock(s.id, HEX.slice(0, 8));
  svc.appendBlock(s.id, HEX.slice(8));
  svc.finalize(s.id);
  const rep = svc.report(s.id);
  assert.equal(rep.blocks.length, 2);
  assert.equal(rep.blocks[0].seq, 0);
  assert.equal(rep.blocks[1].seq, 1);
  assert.equal(rep.digest.hex, "0xCBF43926");
  assert.match(rep.disclaimer, /差错检测/);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("未知会话与未知预设", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const svc = new CrcService(store);
  assert.throws(() => svc.getDigest(999), (e: CrcError) => e.code === "NOT_FOUND");
  assert.throws(() => svc.createSession({ preset: "NOPE" }), (e: CrcError) => e.code === "UNKNOWN_PRESET");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
