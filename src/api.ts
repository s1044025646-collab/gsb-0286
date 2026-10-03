import * as http from "node:http";
import { CrcError } from "./crc";
import { PRESETS } from "./presets";
import { CrcService } from "./service";

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_HEX: 400,
  ODD_LENGTH: 400,
  INPUT_TOO_LARGE: 413,
  PARAM_INVALID: 400,
  PARAM_OUT_OF_RANGE: 400,
  UNKNOWN_PRESET: 400,
  NOT_FOUND: 404,
  SESSION_FINALIZED: 409,
  INTERNAL: 500,
};

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new CrcError("PARAM_INVALID", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * 启动 HTTP API。port=0（默认）时由系统分配空闲端口。
 * 返回实际监听端口。
 */
export function startServer(service: CrcService, port = 0): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/presets") {
        return send(res, 200, { presets: PRESETS });
      }
      if (method === "GET" && url.pathname === "/sessions") {
        return send(res, 200, { sessions: service.listSessions() });
      }
      if (method === "POST" && url.pathname === "/sessions") {
        return send(res, 201, service.createSession(await readBody(req)));
      }
      if (method === "POST" && url.pathname === "/check") {
        return send(res, 200, service.check(await readBody(req)));
      }
      if (parts[0] === "sessions" && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) throw new CrcError("PARAM_INVALID", "会话 id 必须是整数");
        const action = parts[2];
        if (method === "POST" && action === "blocks") {
          const body = await readBody(req);
          return send(res, 200, service.appendBlock(id, body.hex));
        }
        if (method === "GET" && action === "digest") return send(res, 200, service.getDigest(id));
        if (method === "POST" && action === "finalize") return send(res, 200, service.finalize(id));
        if (method === "GET" && action === "report") return send(res, 200, service.report(id));
        if (method === "GET" && action === "trace") {
          const max = url.searchParams.get("maxBytes");
          return send(res, 200, service.trace(id, max === null ? undefined : Number(max)));
        }
      }
      throw new CrcError("NOT_FOUND", `未知路由: ${method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof CrcError) {
        send(res, STATUS_BY_CODE[err.code] ?? 400, { error: { code: err.code, message: err.message } });
      } else {
        send(res, 500, { error: { code: "INTERNAL", message: String(err) } });
      }
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}
