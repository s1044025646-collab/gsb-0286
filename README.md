# crc-lab — 参数化 CRC 流式校验实验服务

离线、本地运行的字节校验实验后端（TypeScript + Node.js + SQLite），提供 HTTP API 与 CLI。
用户选定 CRC 参数、分块输入十六进制字节，获得校验值、累计长度和可复查的逐位状态过程。

> **注意**：CRC 只用于**差错检测**。CRC 相同**不能**证明两份数据一定相同；
> 本项目不实现密码学签名、文件压缩或网络传输协议。

## 环境要求

- Windows 本地运行，Node.js ≥ 22.5（使用内置 `node:sqlite`，无需原生编译）
- 不依赖 Docker、WSL、付费服务或任何在线 API；运行时零第三方依赖

## 快速开始

```powershell
npm install        # 仅安装开发依赖 typescript / @types/node
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部自动化测试
npm start          # 启动 HTTP 服务（默认端口 0 = 自动选择空闲端口）
npm run demo       # 演示：同一内容分三块输入 + 模拟重启续算
```

启动后可指定端口：`node dist/src/cli.js serve --port 8080`
数据默认保存在项目内 `data/` 目录（`--data DIR` 可修改），SQLite 文件为 `data/crc.db`。

## CRC 模型与参数

只支持 8 / 16 / 32 位宽度。参数（均为 width 位以内的无符号整数，可给十进制或 `"0x..."` 字符串）：

| 参数 | 含义 |
| --- | --- |
| `width` | 寄存器位宽：8、16 或 32 |
| `polynomial` | 生成多项式，**省略最高次项**，正常（非反射）形式，如 CRC-32 用 `0x04C11DB7` |
| `init` | 寄存器初始值 |
| `refin` | 是否对每个输入字节先做 8 位反射 |
| `refout` | 是否在输出时对寄存器做 width 位反射 |
| `xorout` | 最终异或值 |

算法（逐位、MSB-first 正规形式）：

1. 若 `refin=true`，先把每个输入字节做 8 位反射；
2. 逐位（高位优先）：`top = 寄存器最高位 XOR 输入位`，寄存器左移 1 位并限制在 width 内，
   若 `top=1` 则异或 `polynomial`；
3. 读取摘要时，在寄存器的**副本**上：若 `refout=true` 做 width 位反射，再异或 `xorout`。

反射只作用于输入字节与输出寄存器，**多项式不反射**，因此不存在“既反射多项式又重复反射结果”的问题。
所有中间值用掩码限制在 width 位内并以 `>>> 0` 归一化，32 位最高位为 1 时输出仍为非负无符号数。

字节顺序：输入按十六进制字符串的字节顺序依次处理，每字节内部高位优先（`refin` 时先整字节反射）。

## 内置预设

| 预设 | 参数 (poly/init/refin/refout/xorout) | `"123456789"` 检查值 |
| --- | --- | --- |
| `CRC-8/SMBUS` | 07 / 00 / false / false / 00 | `F4` |
| `CRC-16/ARC` | 8005 / 0000 / true / true / 0000 | `BB3D` |
| `CRC-16/CCITT-FALSE` | 1021 / FFFF / false / false / 0000 | `29B1` |
| `CRC-32/ISO-HDLC` | 04C11DB7 / FFFFFFFF / true / true / FFFFFFFF | `CBF43926` |

预设名只是便利别名：建会话时会把**真实参数快照**写入 SQLite，之后修改预设定义不影响已建会话。

## HTTP API

所有请求/响应均为 JSON；错误格式为 `{"error":{"code","message"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/presets` | 列出预设 |
| POST | `/check` | 一次性校验：`{preset}` 或 `{params}`，加 `{hex}` |
| POST | `/sessions` | 创建会话（参数快照落库） |
| GET | `/sessions` | 列出会话 |
| POST | `/sessions/:id/blocks` | 追加块：`{hex}` |
| GET | `/sessions/:id/digest` | 读取当前摘要（不写回内部状态） |
| POST | `/sessions/:id/finalize` | 结束会话并记录最终摘要 |
| GET | `/sessions/:id/report` | 导出报告（参数快照、块顺序、摘要） |
| GET | `/sessions/:id/trace?maxBytes=N` | 逐位解释（默认 16 字节，上限 256） |

错误码：`INVALID_HEX`、`ODD_LENGTH`、`INPUT_TOO_LARGE`（单块 > 1 MiB）、
`PARAM_INVALID`、`PARAM_OUT_OF_RANGE`、`UNKNOWN_PRESET`、`NOT_FOUND`、`SESSION_FINALIZED`、`INTERNAL`。

### 语义约定

- **空输入 / 空块**：空 hex 合法。一次性空输入返回 `init` 收尾后的摘要；空块是 no-op，不改变状态也不记录。
- **校验先于消耗**：非法十六进制、奇数长度、超限输入在更新寄存器之前整体拒绝，失败不会改变会话状态。
- **读取摘要无副作用**：摘要基于寄存器副本计算，读取后继续追加与一次性校验结果一致。
- **结束后拒绝追加**：`finalize` 后再 `blocks` 返回 409 `SESSION_FINALIZED`。
- **块边界无关**：同一字节流任意分块结果相同。
- **持久化**：SQLite 保存参数快照、内部未收尾寄存器、已处理长度、块顺序与最终摘要；重启后按会话 id 恢复续算。

## CLI

```powershell
node dist/src/cli.js presets
node dist/src/cli.js check --preset CRC-32/ISO-HDLC --hex 313233343536373839
node dist/src/cli.js check --width 16 --poly 0x8005 --init 0 --refin true --refout true --xorout 0 --hex FF00
node dist/src/cli.js session create --preset CRC-16/ARC --name test1
node dist/src/cli.js session append --id 1 --hex 313233
node dist/src/cli.js session digest --id 1
node dist/src/cli.js session trace --id 1 --max-bytes 4
node dist/src/cli.js session finalize --id 1
node dist/src/cli.js session report --id 1
```

## 逐位解释

`trace` 从参数快照重放已记录的块，逐字节给出：处理前寄存器、原始输入字节、
`refin` 反射后的有效字节、每一位的输入位 / 是否异或多项式 / 处理后寄存器。
超过 `maxBytes` 的字节不展开，响应中以 `omittedRange` 标明省略范围；
重放结束会与持久化寄存器做一致性校验。

## 测试

`npm test` 覆盖：四个预设标准检查值、独立参考实现交叉核对（LSB-first + 反射多项式的
另一套写法，含 00/FF 与伪随机数据）、手算例子（CRC-8/SMBUS 单字节 `0x01 -> 0x07`）、
空输入、不同分块方式、读取摘要后继续、持久化重启续算、32 位无符号输出、
参数越界、失败不改变状态、结束后拒绝追加、trace 截断与 HTTP 端到端。

## 目录结构

```
src/crc.ts      逐位 CRC 核心（反射、参数校验、摘要、逐位 trace）
src/presets.ts  内置预设
src/store.ts    SQLite 持久化（node:sqlite）
src/service.ts  会话/校验业务逻辑（API 与 CLI 共用）
src/api.ts      HTTP 服务（node:http）
src/cli.ts      命令行入口与演示
test/           node:test 测试
```

## 已知限制

- 仅 8/16/32 位宽度，仅逐位实现（未做查表加速，单块上限 1 MiB）。
- HTTP 仅监听 `127.0.0.1`，无认证，面向本地实验用途。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
