# dsh-lan-sync

> 局域网内多台 DeepSeek Harness（DSH）之间同步**配置条目、插件选择、用户 Skills** 的插件。
> 一个自定义**组 ID** 圈定同步范围：同 ID 自动发现、自动入组、自动同步，不同 ID 互不可见。

- 条目级三方合并，不是整文件覆盖
- 冲突进队列，在设置页并排对比后手动裁决
- 每次写盘前自动快照，可一键回滚
- Windows / Linux(WSL) / macOS 跨平台：含路径的配置按平台分变体，Skills 等可移植内容全平台同步

---

## 目录

- [工作原理](#工作原理)
- [快速开始](#快速开始)
- [安装](#安装)
- [界面](#界面)
- [同步内容](#同步内容)
- [冲突与合并](#冲突与合并)
- [跨平台](#跨平台)
- [网络、安全与端口](#网络安全与端口)
- [数据目录与回滚](#数据目录与回滚)
- [故障排查](#故障排查)
- [开发与测试](#开发与测试)
- [已知限制](#已知限制)
- [许可证](#许可证)

---

## 工作原理

```
┌──────────── DSH 实例 A ────────────┐          ┌──────────── DSH 实例 B ────────────┐
│  collector ──► store ──► merger    │          │  collector ──► store ──► merger    │
│      ▲           │         │       │          │      ▲           │         │       │
│      │           │         ▼       │          │      │           │         ▼       │
│  文件系统      blobs/    applier    │          │  文件系统      blobs/    applier    │
│                             │      │          │                             │      │
│  PeerServer :56701 ◄────────┴──────┼──────────┼──── HMAC 签名 HTTP ─────────┘      │
│  Discovery  :56700 UDP 广播        │          │  Discovery  :56700 UDP 广播        │
└────────────────────────────────────┘          └────────────────────────────────────┘
```

1. `collector` 把本机状态拆成**条目**（一个 patch entry、一条依赖、bundle 顺序、一个技能目录）
2. 每个条目带内容哈希与**向量时钟**；变化时本地时钟 +1
3. 对等双方交换清单，按每个 peer 记录的**共同基线**做三方合并
4. 合并干净 → 写盘并等 HMR/文件监听生效；有冲突 → 入队挂起，等人裁决
5. 写盘前快照，失败或误操作可回滚

不是"同步整个文件"，所以两个人改同一份 `cordis.patch.yml` 的不同条目不会互相覆盖。

---

## 快速开始

1. **每台机器安装插件**（见下一节），重启 DSH
2. 打开 **设置 → 局域网同步**，输入或随机生成一个**组 ID**（≥8 位）
3. 其余机器填**同一个组 ID** → 自动发现、自动入组、开始同步
4. 首次对接时，两边**已有且不一致**的条目不会互相覆盖，而是进入冲突队列，由你选边

> 同一台机器上的 Windows + WSL 属于两个实例，也可以用同一个组 ID 互相同步；WSL 侧建议把端口错开（见[跨平台](#跨平台)）。

---

## 安装

要求：DSH 的 `web` profile、Node.js ≥ 20、目标机有 pnpm（仅安装插件时需要）。

### 方式一：本地 tgz（推荐分发给其它机器）

```bash
npm pack                                   # 生成 dsh-lan-sync-0.1.0.tgz
dsh plugin --profile web add "file:/absolute/path/dsh-lan-sync-0.1.0.tgz"
```

### 方式二：源码目录（开发时热更新）

```bash
dsh plugin --profile web add "file:/absolute/path/to/dsh-lan-sync"
```

pnpm 会把该目录链接进 profile；之后改代码刷新页面即可生效。

### 方式三：npm（发布后）

```bash
dsh plugin --profile web add dsh-lan-sync
```

### 启用 bundle

`dsh plugin add` 只写依赖，还需要把包加进 profile 的 bundle 列表。编辑
`~/.dsh/profiles/web/package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-lan-sync"]
    }
  }
}
```

或在 DSH 的 **设置 → 插件** 页面启用。改完重启 DSH（或让 HMR 重载）。

> **pnpm 12 的坑**：Windows/Linux 上都可能报 `ERR_PNPM_NO_AGENT_SKILLS_DIR`。在 profile 的
> `pnpm-workspace.yaml` 里加一段即可：
>
> ```yaml
> skills:
>   dirs:
>     - .agent-skills
> ```

安装完成后，**刷新浏览器页面**（客户端 bundle 在页面加载时注入；插件是在页面打开之后装的就必须刷新）。

---

## 界面

设置页「局域网同步」包含：

| 区域 | 作用 |
|---|---|
| **组卡片** | 输入/随机生成组 ID、显示组 tag 短码、更换组。组 ID 只作为入组口令提交，广播里只出现它的哈希 |
| **状态条** | 本机名、平台、端口、在线设备数、未解决冲突数、条目数 |
| **设备列表** | 名称、平台、地址、方向（双向/只推/只拉/暂停）、最后同步、错误、是否同机 |
| **冲突区** | 选中一条显示左右并排 diff（左本机 / 右对方），可保留本机、采用对方、本机锁定、手动编辑 |
| **同步操作** | 立即同步、手动填 `http://IP:56701` 加入 |
| **快照** | 最近 12 次应用前快照，可回滚（二次确认） |
| **设置** | 自动应用配置、自动安装插件开关 |

另有两个入口：

- **左侧边栏**「局域网同步」图标 → 打开独立面板
- **设置 → 插件** 页的「局域网同步」卡片（当设置页 seat 不可用时的 fallback）

---

## 同步内容

| 类型 | 来源 | 说明 |
|---|---|---|
| `config` | `cordis.patch.yml` 的每个 loader entry（含 `insert` 子项） | 保留注释与 `!!js`；含绝对路径的条目按平台分变体 |
| `dep` | `package.json` → `dependencies` | 缺失的插件通过 DSH 自带 plugin manager 安装 |
| `bundles` | `dsh.profile.bundles` 顺序 | 只合并增删；重排序需要人工裁决 |
| `profile-file` | `pnpm-workspace.yaml` 等 | 如 `skills.dirs` |
| `skill` | `~/.dsh/skills`、`~/.agents/skills` | 目录技能或单文件 `<name>.md`，按文件三方合并 |

**不同步**（白名单固定，代码里没有"任意路径同步"入口）：

`credentials.yaml`、`.env`、`sessions/`、`storages/`、`attachments/`、`cache/`、项目级配置（`AGENTS.md`、`<repo>/.dsh/skills`）、agent preset 文件。

---

## 冲突与合并

### 规则

| 类型 | 自动合并 | 冲突判定 |
|---|---|---|
| `config` | 对象深合并：只取相对基线变化过的键；数组整体视为原子 | 同一键两边改成不同值；删除 vs 修改 |
| `dep` | 单边新增/删除 | 同名包版本范围不同；删除 vs 修改 |
| `bundles` | 集合合并、保留相对顺序 | 任意一边重排了已有顺序 |
| `profile-file` | YAML 对象深合并 | 同键不同值 |
| `skill` | 逐文件行级 diff3；单边增删自动 | 同一文件两侧都改且不能干净合并；二进制两侧都改；删除 vs 修改 |

### 基线

每个条目为每个 peer 记录一条**共同基线**（`bases[peerId]`）。

- 有基线：按 base / ours / theirs 做三方合并
- 没有基线（第一次对接）：内容相同则建立基线；不同则**进冲突**，绝不覆盖
- 删除：墓碑会记录被删版本的哈希；如果被删的正好是本机当前版本，删除直接生效（不会被本地"改过"误判成冲突）

### 五种裁决

| 动作 | 效果 |
|---|---|
| 保留本机 | 用本机版本作为新基线并广播 |
| 采用对方 | 用对方版本覆盖并广播 |
| 两边都要 | 对 config 类型做 JSON 深合并后提交（客户端预填，人可改） |
| 手动编辑 | 直接改 JSON 后提交，校验通过才落盘 |
| 本机锁定 | 该条目以后不再参与同步（适合 MCP 路径这类机器相关配置） |

---

## 跨平台

### 平台变体

采集时自动判定条目作用域：

- 值里出现 `C:\`、`\\`、`.exe/.dll/.cmd/.bat` → `@win32`
- 出现 `/mnt/<盘>/`、`/home/`、`/usr/` 等、`.sh` → `@linux`
- 两种都有 → 标 `mixed`，按 `win32` 处理并在 UI 提示
- 其余 → `any`，全平台同步

`@win32` 与 `@linux` 变体互不比较、互不覆盖，只在 UI 并排展示。

### 路径变量

配置里可以写占位符，应用时按本机展开；带变量的条目视为可移植（`any`）：

| 变量 | 展开为 |
|---|---|
| `{{DSH_HOME}}` | `~/.dsh`（或 `$DSH_HOME`） |
| `{{AGENTS_HOME}}` | `~/.agents`（或 `$DSH_AGENTS_HOME`） |
| `{{USER_HOME}}` | 当前用户主目录 |

例：`cwd: {{USER_HOME}}/work`、`ENGRAM_BIN: {{USER_HOME}}/.local/bin/engram`。

### 文件属性

- **换行**：哈希与合并前统一 LF；写回保留目标文件原有风格
- **权限**：POSIX 记录并恢复 `0755/0644`；Windows 忽略、不产生冲突
- **大小写**：Linux 落地前检查同名不同大小写，冲突不覆盖
- **文件名**：Windows 非法字符与保留名（`CON`、`aux.md` 等）会被跳过并报告
- **符号链接**：只同步指向技能根内、相对路径的链接

### WSL 特例

WSL2 的 NAT 让 UDP 广播互不可达，插件用两条"同机探针"补上：

- Windows 侧扫 `127.0.0.1:56701–56711`（WSL2 的 localhost 转发可直达 WSL 服务）
- Linux 侧扫默认网关的同一段端口

两侧同时用默认端口会冲突（Windows 的 56701 会被本机占用），所以 WSL 侧的
`cordis.patch.yml` 建议加：

```yaml
- id: lan-sync
  name: dsh-lan-sync
  config:
    tcpPort: 56702
    udpPort: 56702
    discovery: false      # 关广播，只靠同机探针/手动 IP
```

### 路径互译

跨平台"导入到本平台"时会把 `F:\x` ↔ `/mnt/f/x`、`C:\Users\<u>` ↔ `/mnt/c/Users/<u>` 互译并先给预览；
不可译的字段标红要求手填，不会静默写入。

---

## 网络、安全与端口

| 端口 | 用途 |
|---|---|
| UDP `56700` | 发现广播（可配 `udpPort`） |
| TCP `56701` | 对等同步接口（可配 `tcpPort`；同机多实例请错开） |

- 组 ID 就是**入组口令**：知道的人都能加入。广播只发 `groupTag = sha256(scrypt(groupId))[:16]`，不发组 ID 本身
- 入组用组密钥做双向 HMAC 挑战应答，之后每个 peer 一个 32 字节 secret
- 每条请求签名：`HMAC-SHA256(secret, METHOD + path + ts + nonce + sha256(body))`，±5 分钟时间窗 + nonce 防重放
- 未配对节点只能读 `/v1/info`、发起 `/v1/join`；其余 401
- 传输是局域网明文 HTTP；同步集不含密钥，需要更强隔离就只让可信机器知道组 ID
- 客户端 UI 的请求走 DSH GUI 同源接口（HttpOnly cookie），Host 侧每条路由都用
  `ctx.connection.requestRejection` 做 CSRF/来源校验

Windows 首次监听会弹防火墙，允许「专用网络」即可。

---

## 数据目录与回滚

```
~/.dsh/lan-sync/<profile>/
  state.json      条目版本（向量时钟、每个 peer 的基线）
  peers.json      已配对设备、方向、最后同步状态
  conflicts.json  待裁决冲突
  group.json      组 ID（0600，不参与同步）
  blobs/          内容寻址的历史版本内容
  snapshots/      每次应用前的文件快照
```

- 快照按批次保存（patch.yml / package.json / 受影响的技能文件）
- UI「快照」区可回滚到任意一次应用之前
- 删掉整个目录 = 忘掉全部同步状态；组 ID 需重新设置（文件删除后本机条目会重新作为"本地版本"参与对接）

---

## 故障排查

| 现象 | 排查 |
|---|---|
| 设置里没有「局域网同步」 | 刷新页面；确认 `dsh.profile.bundles` 含 `dsh-lan-sync`；确认 `node_modules/dsh-lan-sync/lib/client.js` 存在（本仓库曾踩过"安装目录是旧拷贝、缺 client.js"） |
| 设备列表为空 | 两台是否同一组 ID？防火墙是否放行 UDP 56700 / TCP 56701？直接「手动加入」填 `http://对端IP:56701` |
| WSL 加入后同步失败 | WSL 用网关地址访问 Windows，Windows 用 `127.0.0.1:56702` 访问 WSL；确认 WSL 侧端口错开且没有 `discovery` 依赖 |
| 冲突一直不消失 | 冲突条目的自动同步会挂起，必须显式选边或锁定 |
| 插件安装失败 | 目标机需要 pnpm 与网络；失败会回滚依赖声明并记录错误；`ERR_PNPM_NO_AGENT_SKILLS_DIR` 见上文 `skills.dirs` |
| 改了 patch 没生效 | 配置写入由 HMR 重载，等 1–2 秒；仍无效看 DSH 日志里 `lan-sync` 条目 |
| 端口被占用 | 改 `tcpPort`/`udpPort`；同机多实例必须错开 |
| 同步把本机配置覆盖了 | 选「本机锁定」；或从快照回滚 |

排查时可以看：

```bash
ls ~/.dsh/lan-sync/web/
cat ~/.dsh/lan-sync/web/peers.json
curl http://127.0.0.1:56701/v1/info      # 有组且已启动时才有响应
```

---

## 开发与测试

```bash
npm install
npm test                       # 78 个单元/集成测试
node --test "test/**/*.test.js"
node scripts/smoke-client.mjs  # 浏览器半无头冒烟（stub React）
```

测试与 Windows↔WSL 真机联调记录见 [TESTING.md](./TESTING.md)。

### 目录

```
lib/
  index.js          DSH 插件入口（cordis apply）
  host.js           装配 store/collector/applier/engine/server/discovery
  host-api.js       设置页用的同源 HTTP 路由（/api/lan-sync/*）
  client.js         浏览器半（设置页/侧栏/冲突 diff）
  engine/
    clock.js        向量时钟
    diff3.js        行级三方合并与 diff
    merge.js        按 kind 的三方合并
    patch.js        cordis.patch.yml 读写（保注释、保 !!js）
    collector.js    采集本机条目
    store.js        state/blobs/peers/conflicts
    applier.js      写盘、装插件、快照、回滚
    sync-engine.js  反熵调度、冲突判定
    peer-server.js  对等 HTTP 服务（HMAC 鉴权）
    peer-client.js  对等客户端（入组握手）
    discovery.js    UDP 广播
    paths.js        路径/平台判定/变量展开
scripts/            开发辅助脚本（WSL 安装/联调/冒烟，内含本机路径，按需修改）
```

### 协议端点

| 方法 | 路径 | 认证 |
|---|---|---|
| GET | `/v1/info` | 无 |
| POST | `/v1/join` | groupKey 双向 HMAC |
| GET | `/v1/manifest` | peer secret |
| GET | `/v1/blob/<hash>` | peer secret |
| POST | `/v1/notify` | peer secret |

GUI 侧：`/api/lan-sync/status`、`/group`、`/join`、`/sync`、`/conflicts`、`/conflicts/:id/resolve`、
`/snapshots`、`/snapshots/:id/rollback`、`/peers/:nodeId/direction`、`/settings`。

运行时依赖只有 [`yaml`](https://eemeli.org/yaml/)，其余全部是 Node 内置模块。

---

## 已知限制

- 客户端 UI 只在 stub-React 环境验证过注册与渲染，尚未做真实浏览器自动化测试
- `/v1/info` 里的 `dshVersion` 目前取不到运行版本，显示 `0.0.0`；版本兼容门禁未启用
- 符号链接形式的技能目录按普通目录遍历，跨平台时会退化为拷贝
- 传输为局域网明文 HTTP（同步集不含密钥）
- 首次对接不做自动采纳，需要人工在冲突区选边；这是刻意的安全默认

---

## 许可证

[MIT](./LICENSE)
