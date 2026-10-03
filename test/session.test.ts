import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Store } from "../src/db";
import { SessionService } from "../src/session";
import { PRESETS, resolveParams } from "../src/params";
import { explain } from "../src/explain";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crc-")), "test.db");
}

const HEX9 = "313233343536373839"; // "123456789"

test("会话: 分块追加 / 摘要 / 结束 / 结束后拒绝追加", () => {
  const store = new Store(tmpDb());
  const svc = new SessionService(store);
  const s = svc.create(PRESETS["CRC-16/ARC"]);
  svc.append(s.id, "3132");
  const mid = svc.digest(s.id);
  assert.equal(mid.length, 2);
  svc.append(s.id, "33343536373839");
  const done = svc.finalize(s.id);
  assert.equal(done.digestHex, "BB3D");
  assert.throws(() => svc.append(s.id, "00"), /已结束/);
  store.close();
});

test("持久化续算: 关闭重开后继续与一次性一致", () => {
  const db = tmpDb();
  let store = new Store(db);
  let svc = new SessionService(store);
  const s = svc.create(PRESETS["CRC-32/ISO-HDLC"]);
  svc.append(s.id, "313233");
  svc.append(s.id, "343536");
  store.close();
  store = new Store(db);
  svc = new SessionService(store);
  svc.append(s.id, "373839");
  const d = svc.finalize(s.id);
  assert.equal(d.digestHex, "CBF43926");
  assert.equal(d.digest, 0xcbf43926);
  store.close();
});

test("参数快照: 预设被修改后恢复仍用原参数", () => {
  const db = tmpDb();
  let store = new Store(db);
  let svc = new SessionService(store);
  const s = svc.create(resolveParams({ preset: "CRC-8/SMBUS" }));
  svc.append(s.id, HEX9);
  store.close();
  const saved = PRESETS["CRC-8/SMBUS"];
  PRESETS["CRC-8/SMBUS"] = { ...saved, init: 0xaa };
  store = new Store(db);
  svc = new SessionService(store);
  const d = svc.digest(s.id);
  assert.equal(d.digestHex, "F4");
  store.close();
  PRESETS["CRC-8/SMBUS"] = saved;
});

test("失败追加不改变状态（非法 hex / 奇数长度）", () => {
  const store = new Store(tmpDb());
  const svc = new SessionService(store);
  const s = svc.create(PRESETS["CRC-8/SMBUS"]);
  svc.append(s.id, "3132");
  const before = svc.digest(s.id);
  assert.throws(() => svc.append(s.id, "33zz"), /非十六进制/);
  assert.throws(() => svc.append(s.id, "333"), /奇数/);
  const after = svc.digest(s.id);
  assert.equal(after.digestHex, before.digestHex);
  assert.equal(after.length, 2);
  store.close();
});

test("空块合法但不推进状态", () => {
  const store = new Store(tmpDb());
  const svc = new SessionService(store);
  const s = svc.create(PRESETS["CRC-8/SMBUS"]);
  const d0 = svc.append(s.id, "");
  assert.equal(d0.length, 0);
  assert.equal(d0.digestHex, "00");
  store.close();
});

test("报告包含参数快照与块顺序", () => {
  const store = new Store(tmpDb());
  const svc = new SessionService(store);
  const s = svc.create(PRESETS["CRC-16/CCITT-FALSE"]);
  svc.append(s.id, "313233");
  svc.append(s.id, "343536373839");
  const r = svc.report(s.id);
  assert.equal(r.params.poly, "0x1021");
  assert.deepEqual(r.blocks.map((b: any) => b.seq), [0, 1]);
  assert.equal(r.digestHex, "0x29B1");
  store.close();
});

test("逐位解释: 首字节轨迹与省略标记", () => {
  const e1 = explain(PRESETS["CRC-8/SMBUS"], new Uint8Array([0x01]));
  assert.equal(e1.bytes.length, 1);
  assert.equal(e1.bytes[0].steps.length, 8);
  assert.equal(e1.bytes[0].regBefore, "0x00");
  assert.equal(e1.bytes[0].regAfter, "0x07");
  assert.equal(e1.bytes[0].steps[7].xorPoly, true);
  assert.equal(e1.omitted, null);
  const big = new Uint8Array(100).fill(0xab);
  const e2 = explain(PRESETS["CRC-32/ISO-HDLC"], big, 8);
  assert.equal(e2.tracedBytes, 8);
  assert.deepEqual(e2.omitted, { from: 8, to: 99 });
  assert.equal(e2.bytes[0].effectiveByte, "0xD5");
});
