# CRC 流式校验实验服务

离线、本地运行的参数化 CRC 校验后端：TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无 Docker、无外部在线 API）。提供 HTTP API 与 CLI，支持分块流式输入、逐位状态解释、SQLite 持久化与重启续算。

> **重要说明**：CRC 只用于**差错检测**，不是密码学签名。**CRC 相同不代表数据一定相同**（碰撞是常态）。本项目不实现签名、压缩或网络传输协议。

## 环境要求

- Windows 本地，Node.js ≥ 22.5（推荐 ≥ 23，使用内置 `node:sqlite`）
- 无需 Docker / WSL / 付费服务

## 快速开始

```powershell
npm install
npm run build    # 编译 TypeScript 到 dist/
npm test         # 构建并运行全部自动化测试
npm start        # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo     # 演示：分三块输入 + 重启续算
```

指定端口与数据目录：

```powershell
node dist/src/cli.js serve --port 8080
# 或用环境变量: $env:PORT=8080; $env:CRC_DATA_DIR="D:\crc-data"
```

数据默认保存在项目内 `data/` 目录（`CRC_DATA_DIR` / `CRC_DB_PATH` 可覆盖）。

## CRC 参数模型

参数采用 Rocksoft 模型，多项式**省略最高次项**：

| 参数 | 含义 | 表示 |
| --- | --- | --- |
| `width` | 宽度，仅支持 8 / 16 / 32 | 整数 |
| `poly` | 生成多项式（省略最高次项） | 十六进制字符串或数字，须在 width 位内 |
| `init` | 寄存器初始值 | 同上 |
| `refin` | 是否逐字节反射输入（8 位反射） | 布尔 |
| `refout` | 是否在收尾时反射整个寄存器（width 位反射） | 布尔 |
| `xorout` | 收尾异或值 | 同 poly |

算法约定（`src/crc.ts` 逐位基准实现）：

1. 若 `refin` 为真，先逐字节反转每个输入字节；
2. 始终以**最高位优先**方式用未反射的 `poly` 做 8 次移位/异或，每轮都掩码到 width 位；
3. 输出摘要时，若 `refout` 为真则对寄存器做 width 位反射，再异或 `xorout`。

反射只发生在输入字节与最终寄存器上，不会既反射多项式又重复反射结果。32 位时通过 `>>> 0` 保证无符号输出，最高位为 1 不会变成负数。输入字节顺序即流顺序（先到的字节先处理），十六进制串按每两个字符一个字节、高四位在前的常规写法解析。

内置预设（ASCII `123456789` 检查值）：`CRC-8/SMBUS`=F4、`CRC-16/ARC`=BB3D、`CRC-16/CCITT-FALSE`=29B1、`CRC-32/ISO-HDLC`=CBF43926。预设只是参数初值，**会话记录的是完整参数快照**，重启后恢复不受后来预设修改影响。

## HTTP API

| 方法/路径 | 说明 |
| --- | --- |
| `GET /presets` | 列出预设 |
| `POST /check` | 一次性校验：`{preset 或 width/poly/init/refin/refout/xorout, hex}` |
| `POST /explain?maxBytes=16` | 逐位解释（默认追踪前 16 字节，超出标注省略范围） |
| `POST /sessions` | 创建会话，返回 `sessionId` |
| `POST /sessions/:id/blocks` | 追加块 `{hex}`，返回当前摘要与累计长度 |
| `GET /sessions/:id/digest` | 读取当前摘要（不写回内部状态，可继续追加） |
| `POST /sessions/:id/finalize` | 结束会话（幂等；结束后拒绝追加） |
| `GET /sessions/:id/report` | 导出报告：参数快照、未收尾寄存器、长度、块顺序、最终摘要 |

语义约定：

- **空输入 / 空块**：合法。空块不推进状态与长度；空输入的摘要等于 `init` 经收尾后的值。
- **块边界无关**：同一字节流任意分块结果一致。
- **读取摘要无副作用**：基于寄存器副本计算，随后继续追加与一次性校验一致。
- **先校验后消耗**：非法十六进制、奇数长度、超限输入（单块 > 1 MiB）在消耗任何数据前拒绝，状态不变。

错误码（JSON `{error:{code,message}}`）：`INVALID_HEX`、`ODD_LENGTH`、`INPUT_TOO_LARGE`、`PARAM_INVALID`、`PARAM_OUT_OF_RANGE`、`WIDTH_UNSUPPORTED`、`PRESET_UNKNOWN`、`SESSION_NOT_FOUND`、`SESSION_FINALIZED`、`BAD_JSON`、`NOT_FOUND`。

## CLI

```powershell
node dist/src/cli.js presets
node dist/src/cli.js check --preset CRC-32/ISO-HDLC --hex 313233343536373839
node dist/src/cli.js check --width 16 --poly 0x8005 --init 0x0000 --refin true --refout true --xorout 0x0000 --hex 313233343536373839
node dist/src/cli.js explain --preset CRC-8/SMBUS --hex 01
node dist/src/cli.js session create --preset CRC-16/ARC
node dist/src/cli.js session append <id> --hex 3132
node dist/src/cli.js session digest <id>
node dist/src/cli.js session finalize <id>
node dist/src/cli.js session report <id>
```

## 持久化

SQLite 两张表：`sessions`（参数快照 JSON、未收尾寄存器、已处理长度、结束标记、最终摘要、创建时间）与 `blocks`（块序号与原始十六进制，保证块顺序可复查）。进程重启后按快照恢复会话继续追加。

## 测试

`npm test` 覆盖：四个预设标准检查值、与独立参考实现（反射多项式 + LSB-first 的另一 formulation，`test/reference.ts`）交叉核对、手算例子（CRC-8/SMBUS 单字节 `01` → `07`）、空输入、含 00/FF 数据、多种分块、读摘要后续算、持久化重启续算、32 位无符号输出、参数越界、失败不改变状态、结束后拒绝追加、解释截断与省略标记。

## 限制

- 仅支持 8/16/32 位宽度；单块上限 1 MiB（可分块绕过总量限制）。
- 逐位实现以可解释性为先，未做查表/切片优化，不适合大吞吐场景。
- `node:sqlite` 在部分 Node 版本会打印 ExperimentalWarning，不影响功能。
