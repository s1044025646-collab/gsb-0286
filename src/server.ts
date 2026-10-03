import * as http from "node:http";
import { AddressInfo } from "node:net";
import { computeCrc } from "./crc";
import { ApiError, PRESETS, parseHex, resolveParams, toHex } from "./params";
import { SessionService } from "./session";
import { explain } from "./explain";

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("BAD_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(service: SessionService): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const data = JSON.stringify(body, null, 2);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(data);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/presets") {
        return send(200, PRESETS);
      }
      if (method === "GET" && url.pathname === "/health") {
        return send(200, { ok: true });
      }
      // 一次性校验入口
      if (method === "POST" && url.pathname === "/check") {
        const body = await readBody(req);
        const params = resolveParams(body);
        const bytes = parseHex(body.hex ?? "");
        const digest = computeCrc(params, bytes);
        return send(200, { digestHex: toHex(digest, params.width), digest, length: bytes.length, params });
      }
      // 逐位解释（一次性）
      if (method === "POST" && url.pathname === "/explain") {
        const body = await readBody(req);
        const params = resolveParams(body);
        const bytes = parseHex(body.hex ?? "");
        const maxBytes = Math.min(Math.max(Number(url.searchParams.get("maxBytes") ?? 16), 1), 256);
        return send(200, explain(params, bytes, maxBytes));
      }
      if (method === "POST" && url.pathname === "/sessions") {
        const body = await readBody(req);
        const params = resolveParams(body);
        const row = service.create(params);
        return send(201, { sessionId: row.id, params: row.params });
      }
      if (parts[0] === "sessions" && parts[1]) {
        const id = parts[1];
        if (method === "POST" && parts[2] === "blocks") {
          const body = await readBody(req);
          return send(200, service.append(id, body.hex));
        }
        if (method === "GET" && parts[2] === "digest") {
          return send(200, service.digest(id));
        }
        if (method === "POST" && parts[2] === "finalize") {
          return send(200, service.finalize(id));
        }
        if (method === "GET" && parts[2] === "report") {
          return send(200, service.report(id));
        }
      }
      throw new ApiError("NOT_FOUND", `未知路由: ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        send(e.status, { error: { code: e.code, message: e.message } });
      } else {
        send(500, { error: { code: "INTERNAL", message: String(e) } });
      }
    }
  });
}

/** 启动服务；port 为 0 时由系统分配空闲端口（默认行为） */
export function listen(server: http.Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}
