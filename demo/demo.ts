/**
 * 演示：同一内容分三块输入，中途“重启”后续算，结果与一次性校验一致。
 * 运行: npm run demo
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { Store } from "../src/db";
import { SessionService } from "../src/session";
import { PRESETS } from "../src/params";
import { computeCrc } from "../src/crc";

const db = path.join(process.cwd(), "data", "demo.db");
fs.mkdirSync(path.dirname(db), { recursive: true });
if (fs.existsSync(db)) fs.unlinkSync(db);

const chunks = ["313233", "343536", "373839"]; // "123456789" 分三块

let store = new Store(db);
let svc = new SessionService(store);
const s = svc.create(PRESETS["CRC-32/ISO-HDLC"]);
console.log("会话:", s.id);
console.log("追加块 1:", svc.append(s.id, chunks[0]).digestHex);
console.log("追加块 2:", svc.append(s.id, chunks[1]).digestHex);
store.close();
console.log("--- 模拟重启（关闭并重开数据库） ---");
store = new Store(db);
svc = new SessionService(store);
console.log("恢复后追加块 3:", svc.append(s.id, chunks[2]).digestHex);
const final = svc.finalize(s.id);
console.log("最终摘要:", final.digestHex, "长度:", final.length);
const oneShot = computeCrc(PRESETS["CRC-32/ISO-HDLC"], Buffer.from("123456789", "ascii"));
console.log("一次性校验:", oneShot.toString(16).toUpperCase());
console.log(final.digest === oneShot ? "OK 分块+重启续算 与 一次性校验一致" : "FAIL 不一致!");
store.close();
