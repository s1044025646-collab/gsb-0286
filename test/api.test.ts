import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../src/api";
import { CrcService } from "../src/service";
import { Store } from "../src/store";

const HEX = "313233343536373839";

async function post(port: number, url: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

test("HTTP API 端到端", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crc-api-"));
  const store = new Store(dir);
  const { server, port } = await startServer(new CrcService(store), 0);
  try {
    assert.ok(port > 0, "默认应选到空闲端口");

    const once = await post(port, "/check", { preset: "CRC-32/ISO-HDLC", hex: HEX });
    assert.equal(once.status, 200);
    assert.equal(once.body.digest.hex, "0xCBF43926");

    const created = await post(port, "/sessions", { preset: "CRC-16/ARC" });
    assert.equal(created.status, 201);
    const id = created.body.id;

    await post(port, `/sessions/${id}/blocks`, { hex: HEX.slice(0, 10) });
    const mid = await fetch(`http://127.0.0.1:${port}/sessions/${id}/digest`).then((r) => r.json());
    assert.equal(mid.length, 5);
    await post(port, `/sessions/${id}/blocks`, { hex: HEX.slice(10) });
    const fin = await post(port, `/sessions/${id}/finalize`);
    assert.equal(fin.body.digest.hex, "0xBB3D");

    const again = await post(port, `/sessions/${id}/blocks`, { hex: "00" });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "SESSION_FINALIZED");

    const bad = await post(port, "/check", { preset: "CRC-8/SMBUS", hex: "ZZ" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "INVALID_HEX");

    const range = await post(port, "/check", {
      params: { width: 8, polynomial: "0x1FF", init: 0, refin: false, refout: false, xorout: 0 },
      hex: "00",
    });
    assert.equal(range.body.error.code, "PARAM_OUT_OF_RANGE");

    const trace = await fetch(`http://127.0.0.1:${port}/sessions/${id}/trace?maxBytes=2`).then((r) => r.json());
    assert.equal(trace.tracedBytes, 2);
    assert.equal(trace.omittedBytes, 7);

    const report = await fetch(`http://127.0.0.1:${port}/sessions/${id}/report`).then((r) => r.json());
    assert.equal(report.blocks.length, 2);
  } finally {
    server.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
