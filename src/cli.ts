import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { startServer } from "./api";
import { PRESETS } from "./presets";
import { CrcService } from "./service";
import { Store } from "./store";

function parseArgs(argv: string[]): { flags: Record<string, string>; bools: Set<string> } {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
      else bools.add(key);
    }
  }
  return { flags, bools };
}

function paramsFromFlags(flags: Record<string, string>) {
  return {
    width: flags.width,
    polynomial: flags.poly,
    init: flags.init,
    refin: flags.refin,
    refout: flags.refout,
    xorout: flags.xorout,
  };
}

function print(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

const USAGE = `用法: node dist/src/cli.js <命令> [选项]
命令:
  serve [--port N] [--data DIR]        启动 HTTP API（默认端口 0 = 自动选空闲端口）
  presets                              列出内置预设
  check --preset NAME --hex HEX        一次性校验（或用 --width/--poly/--init/--refin/--refout/--xorout）
  session create --preset NAME [--name N] [--data DIR]
  session append --id N --hex HEX [--data DIR]
  session digest --id N [--data DIR]
  session finalize --id N [--data DIR]
  session report --id N [--data DIR]
  session trace --id N [--max-bytes N] [--data DIR]
  sessions [--data DIR]                列出全部会话
  demo                                 三块输入 + 重启续算演示（使用临时数据目录）
`;

export async function run(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;
  const { flags } = parseArgs(sub === undefined ? argv.slice(1) : [sub, ...rest]);
  const dataDir = flags.data ?? path.join(process.cwd(), "data");

  const withService = (fn: (s: CrcService) => unknown) => {
    const store = new Store(dataDir);
    try {
      print(fn(new CrcService(store)));
    } finally {
      store.close();
    }
  };

  switch (cmd) {
    case "serve": {
      const port = flags.port !== undefined ? Number(flags.port) : 0;
      const store = new Store(dataDir);
      const { port: actual } = await startServer(new CrcService(store), port);
      console.log(`CRC 服务已启动: http://127.0.0.1:${actual}  数据目录: ${dataDir}`);
      break;
    }
    case "presets":
      print(PRESETS);
      break;
    case "check":
      withService((s) =>
        s.check(flags.preset ? { preset: flags.preset, hex: flags.hex ?? "" } : { params: paramsFromFlags(flags), hex: flags.hex ?? "" })
      );
      break;
    case "sessions":
      withService((s) => s.listSessions());
      break;
    case "session": {
      switch (sub) {
        case "create":
          withService((s) =>
            s.createSession(
              flags.preset
                ? { preset: flags.preset, name: flags.name }
                : { params: paramsFromFlags(flags), name: flags.name }
            )
          );
          break;
        case "append":
          withService((s) => s.appendBlock(Number(flags.id), flags.hex ?? ""));
          break;
        case "digest":
          withService((s) => s.getDigest(Number(flags.id)));
          break;
        case "finalize":
          withService((s) => s.finalize(Number(flags.id)));
          break;
        case "report":
          withService((s) => s.report(Number(flags.id)));
          break;
        case "trace":
          withService((s) => s.trace(Number(flags.id), flags["max-bytes"] ? Number(flags["max-bytes"]) : undefined));
          break;
        default:
          process.stderr.write(USAGE);
          process.exitCode = 1;
      }
      break;
    }
    case "demo":
      await demo();
      break;
    default:
      process.stderr.write(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

/** 演示：同一内容分三块输入，中途“重启”（关闭并重开数据库）续算。 */
async function demo(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crc-demo-"));
  const data = "313233343536373839"; // ASCII "123456789"
  const chunks = [data.slice(0, 6), data.slice(6, 12), data.slice(12)];

  let store = new Store(dir);
  let svc = new CrcService(store);
  const session = svc.createSession({ preset: "CRC-32/ISO-HDLC", name: "demo" });
  console.log(`创建会话 id=${session.id} (CRC-32/ISO-HDLC)`);
  console.log(`追加块1 ${chunks[0]}:`, JSON.stringify(svc.appendBlock(session.id, chunks[0]).register));
  console.log(`追加块2 ${chunks[1]}:`, JSON.stringify(svc.appendBlock(session.id, chunks[1]).register));
  console.log("读取中间摘要:", JSON.stringify(svc.getDigest(session.id).digest));
  store.close();
  console.log("--- 模拟重启：关闭并重新打开数据库 ---");
  store = new Store(dir);
  svc = new CrcService(store);
  console.log(`恢复会话，已处理长度=${svc.getDigest(session.id).length}，继续追加块3 ${chunks[2]}`);
  svc.appendBlock(session.id, chunks[2]);
  const final = svc.finalize(session.id);
  console.log("最终摘要:", JSON.stringify(final.digest), "(标准检查值应为 0xCBF43926)");
  const once = svc.check({ preset: "CRC-32/ISO-HDLC", hex: data });
  console.log("一次性校验对照:", JSON.stringify(once.digest));
  console.log("逐位解释(前2字节):", JSON.stringify(svc.trace(session.id, 2).bytes, null, 2));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((err) => {
    if (err && err.code) {
      console.error(`错误 [${err.code}]: ${err.message}`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  });
}
