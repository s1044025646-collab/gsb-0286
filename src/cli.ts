#!/usr/bin/env node
import * as path from "node:path";
import { Store } from "./db";
import { SessionService } from "./session";
import { createServer, listen } from "./server";
import { computeCrc } from "./crc";
import { PRESETS, parseHex, resolveParams, toHex } from "./params";
import { explain } from "./explain";

const DATA_DIR = process.env.CRC_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.CRC_DB_PATH ?? path.join(DATA_DIR, "crc.db");

function openService(): { store: Store; service: SessionService } {
  const store = new Store(DB_PATH);
  return { store, service: new SessionService(store) };
}

function parseArgs(argv: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      flags[argv[i].slice(2)] = argv[i + 1] ?? "";
      i++;
    } else rest.push(argv[i]);
  }
  return { flags, rest };
}

function paramsFromFlags(flags: Record<string, string>) {
  const input: any = {};
  if (flags.preset) input.preset = flags.preset;
  if (flags.width) input.width = Number(flags.width);
  for (const k of ["poly", "init", "xorout"] as const) if (flags[k]) input[k] = flags[k];
  for (const k of ["refin", "refout"] as const) if (flags[k] !== undefined && flags[k] !== "")
    input[k] = flags[k] === "true" || flags[k] === "1";
  return resolveParams(input);
}

async function main(): Promise<void> {
  const [cmd, sub, ...extra] = process.argv.slice(2);
  const { flags } = parseArgs(extra);

  switch (cmd) {
    case "serve": {
      const { service } = openService();
      const port = flags.port ? Number(flags.port) : Number(process.env.PORT ?? 0);
      const bound = await listen(createServer(service), port);
      console.log(`CRC 服务已启动: http://127.0.0.1:${bound} (数据目录: ${DATA_DIR})`);
      break;
    }
    case "presets": {
      console.log(JSON.stringify(PRESETS, null, 2));
      break;
    }
    case "check": {
      const params = paramsFromFlags(flags);
      const bytes = parseHex(flags.hex ?? "");
      const d = computeCrc(params, bytes);
      console.log(JSON.stringify({ digestHex: toHex(d, params.width), length: bytes.length }, null, 2));
      break;
    }
    case "explain": {
      const params = paramsFromFlags(flags);
      const bytes = parseHex(flags.hex ?? "");
      console.log(JSON.stringify(explain(params, bytes, Number(flags.maxbytes ?? 16)), null, 2));
      break;
    }
    case "session": {
      const { store, service } = openService();
      try {
        switch (sub) {
          case "create": {
            const params = paramsFromFlags(flags);
            const row = service.create(params);
            console.log(JSON.stringify({ sessionId: row.id, params: row.params }, null, 2));
            break;
          }
          case "append":
            console.log(JSON.stringify(service.append(extra[0], flags.hex ?? ""), null, 2));
            break;
          case "digest":
            console.log(JSON.stringify(service.digest(extra[0]), null, 2));
            break;
          case "finalize":
            console.log(JSON.stringify(service.finalize(extra[0]), null, 2));
            break;
          case "report":
            console.log(JSON.stringify(service.report(extra[0]), null, 2));
            break;
          default:
            throw new Error("用法: session <create|append|digest|finalize|report>");
        }
      } finally {
        store.close();
      }
      break;
    }
    default:
      console.log(`用法:
  serve [--port N]                 启动 HTTP API（默认自动选空闲端口）
  presets                          列出预设
  check --preset P --hex HH...     一次性校验（也可用 --width/--poly/--init/--refin/--refout/--xorout）
  explain --preset P --hex HH...   逐位解释
  session create --preset P        创建会话
  session append <id> --hex HH...  追加块
  session digest <id>              读取当前摘要
  session finalize <id>            结束会话
  session report <id>              导出报告`);
  }
}

main().catch((e) => {
  console.error(e.code ? `[${e.code}] ${e.message}` : e);
  process.exit(1);
});
