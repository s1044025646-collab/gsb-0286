const { Store } = require("../dist/src/db");
const { SessionService } = require("../dist/src/session");
const { createServer, listen } = require("../dist/src/server");
(async () => {
  const svc = new SessionService(new Store(":memory:"));
  const srv = createServer(svc);
  const port = await listen(srv, 0);
  const j = async (r) => ({ s: r.status, b: JSON.parse(await r.text()) });
  const post = (p, body) =>
    fetch(`http://127.0.0.1:${port}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  let r = await j(await post("/check", { preset: "CRC-32/ISO-HDLC", hex: "313233343536373839" }));
  console.log("POST /check ->", r.b.digestHex);
  r = await j(await post("/sessions", { preset: "CRC-16/ARC" }));
  const sid = r.b.sessionId;
  await post(`/sessions/${sid}/blocks`, { hex: "31323334" });
  await post(`/sessions/${sid}/blocks`, { hex: "3536373839" });
  r = await j(await fetch(`http://127.0.0.1:${port}/sessions/${sid}/digest`));
  console.log("GET digest ->", r.b.digestHex, "len", r.b.length);
  r = await j(await post(`/sessions/${sid}/blocks`, { hex: "zz" }));
  console.log("bad hex ->", r.s, r.b.error.code);
  r = await j(await post(`/sessions/${sid}/finalize`, {}));
  console.log("finalize ->", r.b.digestHex);
  r = await j(await post(`/sessions/${sid}/blocks`, { hex: "00" }));
  console.log("append after finalize ->", r.s, r.b.error.code);
  r = await j(await post("/explain", { preset: "CRC-8/SMBUS", hex: "01" }));
  console.log("explain byte0 regAfter ->", r.b.bytes[0].regAfter);
  srv.close();
})();
