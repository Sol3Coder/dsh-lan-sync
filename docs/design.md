# dsh-lan-sync — 局域网 DSH 配置 / 插件 / Skill 同步插件

- 状态：待审阅
- 日期：2026-11-06
- 范围：DSH Web profile 的配置条目、插件依赖与 bundle 选择、用户 Skills 的局域网内多实例同步（Windows + Linux/WSL）
- 决策记录：方案 A（自建同步引擎）；自动化「分级自动」；跨平台策略 C（平台变体 + 手动导入）

---

## 1. 背景与目标

同一局域网内通常有多台运行 DSH 的机器（例如 Windows 主机 + WSL 发行版 + 另一台 Linux 机器）。它们的
`~/.dsh/profiles/<profile>/cordis.patch.yml`、`package.json`（依赖与 bundle 选择）、`~/.dsh/skills` 与
`~/.agents/skills` 目前靠手工复制或脚本迁移，改动不同步，冲突无人裁决。

目标：一个装在同一 profile 里的 DSH 插件，做到

1. **自动发现**局域网内其他 DSH 实例（含同机 WSL 特例），手动 IP 兜底；
2. 自动同步配置条目、插件选择、用户 Skills，**条目级**合并而非整文件覆盖；
3. 真正冲突时**不静默覆盖**，进冲突队列，在 GUI 里并排对比后手动选择、或手动编辑；
4. 自动同步分级可控，任何写操作前有快照、可回滚；
5. Windows 与 Linux 之间：可移植内容（Skills、依赖名、bundle 顺序）自动同步，含绝对路径的配置默认按平台分变体，跨平台搬运需显式"导入"并预览路径翻译。
6. 用一个**用户自定的组 ID** 圈定同步范围：同 ID 自动匹配、自动入组、自动同步；不同 ID 在同一局域网里互不可见。

### 1.1 非目标

- 不同步：`credentials.yaml`、`.env`、`storages/`、`sessions/`、`attachments/`、`cache/`、项目级配置（`AGENTS.md`、`<repo>/.dsh/skills`）、agent preset 文件
- 不做中心服务器、不做公网穿透、不做跨 profile 同步
- 不自动更新插件自身
- 不合并 MCP 进程状态、不做会话记忆同步（那是 `.wsl-dsh-setup/bin/dsh-session-sync.mjs` 的职责）

### 1.2 验收标准

| # | 场景 | 预期 |
|---|---|---|
| 1 | 同网段两台实例启动 | ≤15 s 内互相出现在设备列表 |
| 2 | Windows + WSL 两台实例 | 同机探针发现，同组自动入组成功 |
| 3 | A 改一个 config 条目，B 未改 | B ≤5 s 内自动应用，B 的 patch 注释保留 |
| 4 | A、B 同时改同一 entry 的不同字段 | 自动合并，无冲突 |
| 5 | A、B 同时改同一字段为不同值 | 生成冲突，UI 显示并排 diff |
| 6 | 冲突选"保留本机" | 对方收敛到本机值，不重复弹冲突 |
| 7 | A 安装一个插件，B 未安装 | 按策略自动安装或排队；安装前有快照 |
| 8 | Linux 新增 skill，Windows 端 | 出现在 catalog；CRLF 文件不被误判为修改 |
| 9 | 撤销一次应用 | 文件内容与插件状态回到应用前 |
| 10 | 未配对节点发写请求 | 拒绝（401/403） |
| 11 | 单测 + 集成场景脚本 | 全绿 |
| 12 | 两台填同一个组 ID | 无需任何确认，≤15 s 自动入组并开始同步 |
| 13 | 两台组 ID 不同 | 互相不可见、无任何数据交换 |

---

## 2. 术语

| 术语 | 含义 |
|---|---|
| 条目 / item | 同步的最小单元：一个 config entry、一个依赖、bundle 顺序、一个 skill 目录、一个 profile 文件 |
| 变体 / scope | 条目的平台适用范围：`any`、`win32`、`linux` |
| 基线 / base | 该条目上一次双方达成一致的 blob 哈希，三方合并的公共祖先 |
| 时钟 / clock | 向量时钟 `{nodeId: counter}`，判断新旧与并发 |
| 对等体 / peer | 已配对、可同步的另一台 DSH 实例 |
| 组 / group | 由用户自定组 ID 圈定的同步范围；同 ID 自动互相发现与同步 |
| 快照 | 应用前保存的原始文件与插件状态副本 |

---

## 3. 总体架构

单进程 Host 插件 `dsh-lan-sync`，分解为七个模块（`lib/` 下每个模块一个目录，单文件不超过 400 行）：

```
┌──────────────────────────── Host 进程（每台 DSH） ────────────────────────────┐
│                                                                              │
│  collector ──> store <──> merger ──> applier ──> pluginManager / 文件系统      │
│      │           │           │         │                                     │
│      │           │           └── conflicts                                   │
│      │           └── blobs / snapshots                                       │
│      │                                                                       │
│  transport: UDP discover + HTTP peer server (:56701)                          │
│  api:     HTTP routes on ctx.webServer (/api/lan-sync/*)  ← 本机浏览器         │
│  tool:    lan_sync（模型侧）                                                  │
└──────────────────────────────────────────────────────────────────────────────┘
              ▲ UDP 56700 广播/单播            ▲ HMAC 签名的 HTTP（LAN）
              │                              │
      其他 DSH 实例（Windows / Linux / WSL） ─┘
```

浏览器半 `lib/client.js` 只渲染设置页与侧边栏角标，所有操作调用本机 `/api/lan-sync/*`（同源、CSRF 校验），**不直接连局域网**。

### 3.1 数据流

1. 文件变化 / 用户操作 → `collector` 重算本机条目 → `store` 写入新版本（clock 自增）→ `transport` 向在线 peer 发 `notify`。
2. peer 收到通知或 30 s anti-entropy 到期 → `GET /v1/manifest` → 逐条目比较时钟。
3. 对方更新且本机未改 → 拉 blob → `applier` 应用；双方都改 → `merger` 三方合并：
   - 干净 → 生成合并版本（clock 取双方并集 + 本机自增）→ 应用；
   - 冲突 → 写入 `conflicts.json`，条目挂起自动同步，UI 提示。
4. 解决冲突 → 生成新版本 → 应用 → 广播。

### 3.2 运行位置

- Host 插件条目：`dsh-lan-sync`，`inject: ['webServer', 'connection']`，`ctx.get()` 探测可选服务 `pluginManager` / `configEditor` / `tools`（缺任何一项都有降级路径）
- 每个 profile 独立状态目录：`<DSH_HOME>/lan-sync/<profile>/`
- 发现/传输端口默认 `56700/udp`、`56701/tcp`，可配；被占用自动 +1（最多 +10），端口随 announce 广播

---

## 4. 同步对象与条目模型

### 4.1 采集范围

| 来源 | 文件/目录 | 条目 kind | 默认 scope |
|---|---|---|---|
| profile | `cordis.patch.yml` 的每个 loader entry（含 `insert` 子项，按 `id`） | `config` | 按 4.3 判定 |
| profile | `package.json` → `dependencies` 每条 | `dep` | `any` |
| profile | `package.json` → `dsh.profile.bundles`（有序） | `bundles` | `any` |
| profile | `pnpm-workspace.yaml`（如 `skills.dirs`） | `profile-file` | `any` |
| 用户 | `<DSH_HOME>/skills/<name>/`（跳过 `.system`） | `skill` | `any` |
| 共享 | `<AGENTS_HOME>/skills/<name>/` | `skill` | `any` |

不采集：`cordis.yml`（恒为 `[]`）、`.plugin-manager/`、`.dsh-market/`、`node_modules/`。

### 4.2 条目 key

```
config:<entryId>[@win32|@linux]
dep:<npmName>
bundles
profile-file:pnpm-workspace.yaml
skill:<dsh-home|agents-home>:<skillName>
```

- `config` 条目的变体后缀只在 scope ≠ `any` 时出现。
- 技能内部文件不单独建条目，作为条目的 tree 子项（见 4.5）。
- 所有条目隐含属于当前组：清单只在同组 peer 之间交换，跨组不产生任何条目可见性。

### 4.3 平台作用域判定

按顺序判定，命中即停：

1. 用户在 UI 显式设置 → 采用设置值（持久化在 `state.json` 的 `scopeOverrides`）
2. 序列化后的值匹配 `[A-Za-z]:[\\/]`、`\\\\`、`\.exe\b`、`\.dll\b`、`/mnt/[a-z]/`、`/home/`、`/usr/`、`\.sh\b` → `win32` 或 `linux`（两种都命中 → `win32` 优先并标记 `mixed`，UI 提示）
3. 其余 → `any`

`mixed` 条目仍按平台分变体，但 UI 显示"检测到混合路径，建议改用路径变量"。

### 4.4 条目状态

```jsonc
{
  "key": "config:mcp-engram@win32",
  "kind": "config",
  "scope": "win32",
  "clock": { "n_a1b2": 7 },          // 向量时钟
  "hash": "sha256:…",                 // 当前内容 blob
  "baseHash": "sha256:…",             // 上次双方一致版本
  "deleted": false,
  "deletedAt": null,
  "pinned": false,                    // 本机锁定：永不接受远端覆盖
  "origin": "n_a1b2",                 // 最后写入者
  "updatedAt": "2026-11-06T03:00:00Z"
}
```

- 内容 blob 一律按 sha256 内容寻址存储在 `blobs/`。
- 删除写 tombstone（`deleted: true` + 删除时钟），保留 30 天后 GC。
- `pinned` 条目只参与"清单展示"，不参与合并。

### 4.5 条目内容格式

| kind | blob 内容 |
|---|---|
| `config` | 该 entry 的 JSON 规范化对象（`{id, name, disabled?, config}`），不含注释；注释由本机文件格式保留，不参与同步 |
| `dep` | `{"name":"…","spec":"^0.2.1","kind":"prod"}` |
| `bundles` | `{"list":["@deepseek-ai/dsh-base", …]}` |
| `profile-file` | `{"path":"pnpm-workspace.yaml","data":{…解析后的 JSON…}}` |
| `skill` | tree：`{"files":{"SKILL.md":"sha256:…","scripts/run.sh":"sha256:…"},"modes":{"scripts/run.sh":"0755"}}`，文件内容各自成 blob |

---

## 5. 发现与配对

### 5.0 同步组（groupId）

用户自定一个**组 ID**（例如 `lab-2026` 或点"随机生成"得到的 16 位串）。同一组 ID 的实例自动归为一组：自动发现、自动匹配、自动配对、自动同步，不需要逐个确认。不同组在同一个局域网里互不可见。

- **存储**：`<DSH_HOME>/lan-sync/<profile>/group.json`（0600），不写进 `cordis.patch.yml`，不参与同步，不出现在任何清单里。
- **派生**：`groupKey = HKDF-SHA256(groupId, "dsh-lan-sync/v1")`；广播里只出现 `groupTag = sha256(groupKey)[0:16]`（16 位十六进制），不出现组 ID 本身。
- **自动配对**：tag 相同 → 双方各出 32 字节 nonce 做双向 HMAC-SHA256 挑战应答，验通过即判定同组，随后生成 32 字节 per-peer `secret` 用于传输签名（见 6.2）。整个过程无人工步骤。
- **入口条件**：组 ID 长度 ≥ 8；界面默认提供"随机生成"，并在输入短 ID 时提示"组 ID 就是入组口令，局域网内知道的人都能加入"。
- **换组**：清空 peer 与 base、按新组重新接入；本机条目保留。UI 二次确认。
- **缺省**：未设置组 ID 时不广播、不发现，设置页引导先建组。

### 5.1 UDP 广播

- 端口 `56700`，每 10 s 向 `255.255.255.255` 与每个网卡的定向广播地址各发一次；启动立即发一次。
- 报文（明文 JSON，≤512 B）：

```json
{ "v": 1, "nodeId": "n_a1b2c3", "name": "win-desktop/web", "platform": "win32",
  "profile": "web", "dshVersion": "0.2.1-rc.5", "port": 56701,
  "groupTag": "9f3c1a77d2e405b8", "ts": 1762398000000 }
```

- 收到后若未见过，向源 IP:port 单播回一次 announce（快速收敛）；45 s 无更新标记离线。
- 忽略：自己的 `nodeId`、非私有网段来源、协议版本不兼容（major 不同）、`groupTag` 与本机不同（可折叠为"其他组 N 台"，不展示细节）。
- `groupTag` 相同但未配对 → 自动进入 5.4 的组内握手，成功后即可同步。

### 5.2 同机探针（WSL 特例）

WSL2 NAT 下广播不互通，额外两条探测：

- **Windows 侧**：每 30 s 试连 `127.0.0.1:<port..port+10>`，命中 `/v1/info` 即认为"同机 WSL 实例"。
- **Linux 侧**：读取 `ip route` 的 default 网关（或 `/proc/net/route`），试连 `<gateway>:<port..port+10>`。
- 命中后标记 `sameHost: true`，在设备列表置顶显示"同一台机器上的 DSH"；`groupTag` 相同则直接走 5.4 A 自动入组，不同则折叠为"同机的其他组"。

### 5.3 手动 IP

`peers.json` 的 `manual` 列表（`host:port`），每 30 s 探活；用于广播被防火墙拦截、跨网段、Docker 网桥等场景。

### 5.4 配对

两条路径，组内自动路径是默认：

**A. 组内自动（tag 相同即触发）**

1. 双方互发 `POST /v1/join {nodeId, name, platform, dshVersion, nonceA}`；
2. 对端回 `nonceB` + `HMAC(groupKey, "join" ‖ nonceA ‖ nonceB ‖ nodeId)`；
3. 本机验签 → 生成 per-peer `secret`（32 B），用 `AES-256-GCM(groupKey, nonce)` 加密后回传；
4. 双方写入 `peers.json`（0600），状态 `paired`，立即开始首次接入（7.4）。
5. 全过程无 UI 操作；设备列表出现新成员并提示"已自动加入组"。

**B. 手动配对码（跨组临时接入 / 重新配对 / 排查）**

1. A 在 UI 点"配对" → 生成本机 6 位数字码，5 分钟有效，最多 3 次尝试；
2. B 输入 IP + 码 → `POST /v1/pair {code, nodeId, name, platform, dshVersion}`（未认证但受限流）；
3. 校验通过 → A 生成 32 字节 `secret` 返回，双方以 `nodeId` 为键写入 `peers.json`；
4. 任一方可"解除配对"，删除 secret，peer 条目保留为离线态 30 天。

两种路径产出的 peer 记录一致；手动配对不改变组的归属。

### 5.5 方向策略

每个 peer 有 `direction: 'both' | 'push' | 'pull' | 'paused'`：

- `both`（默认）：双向
- `push`：只把本机变更推给对方，不接受对方的变更
- `pull`：只接受对方变更
- `paused`：完全不通信（仍显示在线）

---

## 6. 传输协议

独立 HTTP 服务（`node:http`），绑 `0.0.0.0`（可配网卡），端口默认 `56701`。

### 6.1 端点

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| GET | `/v1/info` | 无 | `{v, nodeId, name, platform, profile, dshVersion, groupTag, joinedAt}` |
| POST | `/v1/join` | groupKey HMAC | 组内握手（5.4 A） |
| POST | `/v1/pair` | 无（限流） | 手动配对码（5.4 B） |
| GET | `/v1/manifest?since=<ts>&page=<n>` | HMAC | 全量或增量条目元数据（分页） |
| GET | `/v1/blob/<sha256>` | HMAC | 内容 blob（二进制安全） |
| POST | `/v1/notify` | HMAC | 轻量通知 `{items:[key…], blobs:[sha…]}` |
| POST | `/v1/push` | HMAC | 可选直推：`{items:[…], blobs:[base64…]}`（≤4 MB） |

### 6.2 签名

```
LanSync <nodeId>:<ts>:<nonce>:<hex(hmac_sha256(secret, canon))>
canon = METHOD + "\n" + PATH_WITH_QUERY + "\n" + ts + "\n" + nonce + "\n" + hex(sha256(body))
```

- 时间窗 ±300 s；nonce 缓存 10 分钟（LRU 16k）；`timingSafeEqual` 比较。
- 失败返回 401，连续 10 次失败 → 该 IP 冷却 5 分钟。
- 只接受来自私有网段或回环的连接；公网来源直接断开。

### 6.3 限制

- 单请求体 ≤ 8 MB，单个 blob ≤ 2 MB（技能大文件不同步，UI 报"超出上限，已跳过"）。
- 并发请求 ≤ 8；清单响应 ≤ 500 条目（超出分页 `?page=`）。
- 所有响应 `Cache-Control: no-store`。

---

## 7. 合并、冲突与首次接入

### 7.1 比较与合并算法

对每个条目 key：

1. 时钟相等 → 无操作。
2. 本机时钟支配对方 → 无操作（对方会来拉）。
3. 对方支配本机：
   - 本机 `hash == baseHash`（本机未改）→ 直接采用对方（`base = remote.hash`）。
   - 否则 → 三方合并（base/ours/theirs）。
4. 并发（互不支配）→ 三方合并。
5. 合并成功 → 新 clock = 双方 clock 逐键取 max 后本机 +1；`baseHash = 合并结果`；应用。
6. 合并冲突 → 生成 conflict 记录，条目进入 `suspended`，停止自动同步直到解决。
7. `baseHash` 缺失（首次接入）→ 不自动合并，见 7.4。

### 7.2 各 kind 的合并规则

| kind | 自动合并 | 冲突判定 |
|---|---|---|
| `config` | 对象深合并：仅一边相对 base 改变的键取该边；数组整体视为原子值 | 同一键两边改成不同值；一边删除、一边修改 |
| `dep` | 集合合并：单边新增/删除 | 同名依赖 spec 不同；删除 vs 修改 |
| `bundles` | 序列 LCS 合并，双边新增取并集保序 | 双边对同一段的相对顺序不一致 |
| `profile-file` | YAML 对象深合并（同 config） | 同键不同值 |
| `skill` | 目录树按文件合并：文本文件行级 diff3；新增/删除单边自动 | 同一文件两侧都改且无法干净合并；二进制两侧都改；删除 vs 修改 |

补充：
- 文本判定：不含 NUL 且扩展名在允许列表（`.md .txt .json .yaml .yml .js .mjs .cjs .ts .sh .py .toml .ini .conf`），其余按二进制。
- `config` 的数组原子策略是刻意选择：MCP `args` 顺序敏感，宁可让人裁决。
- 合并结果若与任一侧完全相同 → 不产生新版本（避免抖动）。

### 7.3 冲突记录

```jsonc
{
  "id": "c_9f21",
  "key": "config:mcp-engram@win32",
  "kind": "config",
  "base": "sha256:…", "ours": "sha256:…", "theirs": "sha256:…",
  "oursBy": "n_local", "theirsBy": "n_b0f3",
  "paths": ["config.env.ENGRAM_PROJECT"],   // 冲突字段路径
  "createdAt": "2026-11-06T03:12:00Z",
  "state": "open"
}
```

解决动作（`POST /api/lan-sync/conflicts/:id/resolve`）：

| 动作 | 效果 |
|---|---|
| `ours` | 采用本机版本，clock 取双方并集 +1，广播 |
| `theirs` | 采用对方版本 |
| `both` | config：本机条目改 id（`<id>-<node>`）后两份共存；skill 文件：冲突文件改名为 `<name>.conflict-<node>` 保留两份 |
| `edit` | 提交手工内容（JSON/YAML/文本），校验格式后写入 |
| `pin` | 本机锁定该条目，删除冲突，不再同步此项 |

解决后 `base = 结果`，`state = resolved`，保留 7 天供追溯。

### 7.4 首次接入

新 peer 加入且无 `baseHash` 时，不做自动合并。默认走"接入向导"，组内可改为全自动：

1. 拉取对方清单，按 kind/scope 分组显示数量与差异摘要；
2. 用户选"以对方为准"（`any` + 同平台条目全量导入）、"只取 Skills"、"逐项选择"或"以本机为准（推送）"；
3. 导入时写 base，clock 合并；
4. 本机 `pinned` 条目与 scope 不同的条目自动跳过并在结果中列出。

**组内自动采用**（设置项 `firstJoinPolicy`，默认 `ask`）：

- `ask`：每次新 peer 接入都走向导；
- `adopt-remote`：从组内**种子节点**（加入时间最早、条目最多者；由 announce 的 `joinedAt` + 条目数选出）自动全量采用，过程写入"待同步区"可查、可回滚；
- `push-local`：反向，把本机状态推给新成员（用于"我先配好，其他机器跟随"）。

同一 profile 第二次接入沿用已有 base，不再向导。

---

## 8. 跨平台适配

### 8.1 原则

- **可移植内容**（`any`）：Skills、依赖名、bundle 顺序、路径变量化后的配置 —— 全平台同步。
- **平台相关配置**：按 `@win32` / `@linux` 分变体，变体之间不比较、不覆盖、不冲突，只做并排展示。
- **跨平台搬运配置**：显式动作"导入到本平台"，先预览翻译结果，确认后写成本平台变体。

### 8.2 路径互译

双向规则（只用于生成建议，不自动落盘）：

| Windows | Linux | 说明 |
|---|---|---|
| `F:\desktop\x` | `/mnt/f/desktop/x` | 盘符 → `/mnt/<小写盘符>`，`\` → `/` |
| `C:\Users\Administrator` | `/mnt/c/Users/Administrator` | 同上 |
| `%USERPROFILE%\x` / `~\x` | `~/x` | 用户目录 |
| `%DSH_HOME%` / `{{DSH_HOME}}` | 同 | harness home |
| `\\wsl$\<distro>\home\u` | `/home/u` | WSL UNC 反解（尽力而为，失败则标不可译） |

不可译（如 `D:\Program Files\...` 在 WSL 里无对应、或 Linux 的 `/opt/...` 在 Windows 无对应）→ 该字段在导入预览里标红，要求手填或跳过该条目。

### 8.3 路径变量

配置条目文本中允许以下占位符，采集时保留原样、应用时展开：

| 变量 | 展开为 |
|---|---|
| `{{DSH_HOME}}` | `resolveDshHome()` |
| `{{AGENTS_HOME}}` | `resolveAgentsHome()` |
| `{{USER_HOME}}` | `os.homedir()` |

含占位符的条目 scope 判定为 `any`（除非另有平台标记）。反向：导入时可把本机绝对路径建议替换成占位符。

### 8.4 文本与文件属性

- **换行**：哈希与比较前统一 `\r\n` → `\n`；写回时按目标文件原有主风格（检测首个换行）恢复。skill 文件默认 LF，Windows 上新文件也用 LF（避免未来 Linux 端误判）。
- **编码**：UTF-8；含 BOM 的文件保留 BOM 标记，其余不带。
- **权限**：POSIX 记录并恢复 `0755`/`0644`（skill 内脚本）；Windows 忽略，不产生冲突。
- **大小写**：Linux 落地前对同目录做大小写不敏感比较，发现 `Foo.md`/`foo.md` 撞名 → 冲突，不覆盖。
- **符号链接**：只同步指向技能根内、相对路径的链接；绝对或越界链接跳过并在结果中告警。Windows 上的符号链接按普通文件读取内容（不还原）。
- **文件名**：拒绝 `<>:"|?*` 与 Windows 保留名（`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`）——若 Linux 侧技能含此类文件名，Windows 端跳过并告警。

### 8.5 跨平台导入流程

1. 选择对方（另一平台）的条目 → "导入到本平台"
2. 弹出预览：逐字段显示原文、翻译建议、不可译项（红）
3. 用户可逐字段确认/改写；确认后生成本平台变体（新 key、clock 取双方并集 + 本机 +1）
4. 写入 patch → HMR 重载；失败可回滚

### 8.6 版本兼容

| 检查 | 行为 |
|---|---|
| 协议 major 不同 | 不发现、不连接，设备列表显示"版本不兼容" |
| DSH `minor` 不同 | 可连，但 `config` 条目降为"建议"（需手动应用），`skill`/`dep` 正常 |
| DSH `major` 不同 | 只读模式（只能看清单） |
| 缺 pnpm | 插件同步降级为待办，不再自动安装 |

---

## 9. 应用与回滚

### 9.1 顺序

1. 取应用锁（`apply.lock`，pid + 时间戳，60 s 过期可抢占）
2. 快照受影响文件 → `snapshots/<ts>/`（一批一个目录，内含本批全部条目）
3. 按 kind 写入：
   - `config`：按 9.2 的通道写入（configEditor 优先，Document 降级）→ 原子写
   - `profile-file`：YAML Document 同法
   - `dep` / `bundles`：调 `pluginManager`（见 9.3）
   - `skill`：逐文件写（先写 tmp 再 rename），删除多余文件，POSIX `chmod`
4. 等待热重载稳定（HMR 重建或 2 s 超时）→ 回报状态
5. 失败 → 用快照回滚该条目 → 标 `apply-failed`，进入冲突队列展示错误

### 9.2 patch.yml 写入

写入通道按优先级二选一：

1. **首选 `ctx.configEditor.edit(entry, (current, inherited) => next)`** —— 受支持的写入口，只写 profile 的 `cordis.patch.yml`，自动保留注释与 `!!js`，并与 HMR 串行，避免与重载互相踩踏。
2. **降级：`yaml` v2 的 `Document` API** —— 当 configEditor 不可用，或需要**新增**一个尚不存在的 entry（configEditor 面向已加载条目）时使用。定位规则：顶层序列按 `id` 匹配，`insert` 子序列递归匹配；新增顶层 entry 追加到末尾，`insert` 内的新增追加到该 `insert` 末尾。
3. 降级路径首次写盘会规范化缩进与引号风格（不保留原始对齐空白）——在 UI 首次应用前提示一次。
4. 两种通道都先写 tmp 再 rename，写入前完成快照；写后等待 HMR 重载稳定（见 9.1）。

### 9.3 插件安装

- 首选 `ctx.pluginManager`：`installBundle(spec, opts)`、`removeBundle(name)`、`setBundleEnabled(name, on)`、`setPluginEnabled(id, on)`、`listBundles()`；更新版本 = 移除 + 安装（`installBundle` 对同名已装包的行为以实测为准）。
- 服务不可用 → 降级：只写 `package.json` 依赖与 bundles 选择，UI 标"需要手动 pnpm install"，不自动执行包管理器。
- 安装前快照 `package.json`、`pnpm-lock.yaml`、`dsh.profile.bundles`；失败按快照恢复。
- `link:` / `file:` / git 依赖视为平台相关（scope = 本平台），不跨平台同步。

### 9.4 快照与回滚

- 每次应用一个批次目录：`snapshots/<ts>/`，含 `files/`（相对路径副本）、`manifest.json`（条目、原 hash、插件状态）。
- 保留最近 10 份（可配），超出按时间淘汰。
- UI 可"回滚到此快照"：恢复文件 + 恢复依赖声明（插件安装回滚尽力而为，失败则提示手动）。

### 9.5 并发

- 应用串行队列；采集与传输并发安全（store 用"读-改-写 + 版本号校验"）。
- 同一 profile 多实例（不同 DSH_HOME）互不干扰。
- 监听自身写入：应用期间暂停 collector 的 debounce（`applying` 标志），避免把自己的写入当成"本地变更"再广播。

---

## 10. 自动化策略

| 项 | 默认 | 可配 |
|---|---|---|
| `config` / `profile-file` 自动应用 | 开 | 全局 / 按 peer |
| `skill` 自动应用 | 开 | 全局 / 按 peer |
| 插件安装自动执行 | 开（装前快照、失败回滚） | 关 → 排队待确认 |
| 大型变更（单批 >20 条目） | 需确认 | 阈值可配 |
| 冲突条目 | 挂起自动同步 | — |
| 全局暂停 / 按 peer 暂停 | 关 | 开 |

另有"只读跟随"模式：某 peer 设为 `pull` 且本地永不推送，等价于单向订阅。

---

## 11. 界面

### 11.1 设置页「局域网同步」

- **组卡片**（首次进入时的第一步）：组 ID 输入框 + "随机生成" + 显示/隐藏切换 + 当前组 tag 短码 + "更换组"；未设置组时其余区块置灰并引导先建组
- **状态条**：本机名 / nodeId 短码 / 端口 / 发现开关 / 在线设备数 / 未解决冲突数
- **设备列表**：名称、平台图标、IP:port、profile、DSH 版本、最后同步时间、方向下拉、配对状态、在线点、操作（配对/解除/设为只读）
- **冲突区**：卡片列表 → 点开抽屉，并排 diff（左本机/右对方，字段级高亮），底部三个主按钮（保留本机 / 采用对方 / 两边都要）+ "手动编辑" + "本机锁定"
- **待同步区**：本次拉到的条目与状态（已应用 / 已合并 / 挂起 / 失败），可展开看摘要
- **首次接入向导**：全屏三步（选择对方 → 选择范围 → 预览并确认）
- **快照**：时间线列表 + 回滚按钮
- **设置**：自动级别、首次接入策略、端口、发现开关、手动 IP、排除条目、日志级别

### 11.2 侧边栏

一个入口「局域网同步」，图标带未解决冲突数角标；点击跳到设置页对应锚点。

实现方式（左栏不是单个 seat）：`sidebar.panellist`（list，`id` 必须与 `main` 面板 key 一致）+ `main`（keyed 面板本体）双注册，选中时 `ctx.layout.selectPanel(id)`；角标用 `sidebar.toggle.badge`。若 `main` 面板注册失败，退化为只做设置页。

### 11.3 客户端实现约束

- 单文件 `lib/client.js`，手写模块工厂（`window.__ModuleLoader__.load`）；`require` 只能取 shell 播种表：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`zod`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives` 等，表外请求必须在 `dsh.client.external` 声明
- `module.exports.inject = ['slots', 'locale']`；`apply(ctx)` 内用 `ctx.slots.inject(seat, () => ctx.slots.register({...}, Component))` 注册，`ctx.effect()` 包住可回收副作用
- 设置页 seat 首选 `settings.section`（list，`id` / `order` / `label`）；该 seat 无本机第三方实例，实现时用 `ctx.slots.inject` 探测，失败则退到 `plugins.item` 卡片（有 `dsh-time-machine` 实例可参照）
- 渲染细节用 `@deepseek-ai/dsh-client-ui-primitives`（`SettingsForm` 等），不自己造表单
- 所有请求是同源 `fetch('/api/lan-sync/...')`，**不带任何鉴权头**：HttpOnly + SameSite=Strict cookie 由浏览器自动携带
- Host 侧每条路由第一行必须 `const rej = ctx.connection.requestRejection(req); if (rej) return res.writeHead(rej).end()` —— `webServer` 不提供任何全局鉴权，漏掉这一步等于把同步控制面暴露给本机任意网页
- diff 由 Host 计算好 hunk 下发，客户端只渲染（避免在浏览器里塞 diff 库）
- 所有文案中英双语，`ctx.locale.register(NS, { zh, en })`
- 样式在 factory 内幂等注入 `<style data-dsh-plugin="…">`，复用 `--dsw-alias-*` 主题变量

### 11.4 模型工具 `lan_sync`

动作：`status`、`list_peers`、`sync_now`、`list_conflicts`、`resolve_conflict`、`pin`、`set_policy`。

- 只读动作默认可用；写动作（`sync_now` 触发安装、`resolve_conflict`、`set_policy`）需审批。
- 输出人类可读摘要 + 结构化字段（peer、条目、冲突 id）。

---

## 12. 安全与隐私

- 同步集白名单固定，代码里不存在"任意路径同步"入口。
- **组 ID 即入组口令**：知道组 ID 的实例能自动加入并同步。广播只暴露 `groupTag`（哈希），并默认生成随机组 ID；短 ID 在 UI 明确警告。组内信任是"口令级"，不做设备白名单（需要更严可关自动加入、只留手动配对码）。
- patch 里不含密钥：`apiKeyEnv` 只是引用名，真实密钥在 `.credentials.yaml`（不在同步集）；但 `baseURL` / `command` / `cwd` / MCP `env` 仍可能带本机信息，按第 8 章分平台或变量化。
- 未配对：仅 `GET /v1/info`、`POST /v1/join`（需 groupKey 证明）、`POST /v1/pair`（限流）；其余 401。
- secret 0600；配对码 5 分钟、3 次尝试；配对成功后 UI 显示设备指纹（secret 前 6 位哈希）。
- 只接受私有网段/回环来源；不监听公网。
- 日志脱敏：不打印 secret、签名原文、文件内容（只打 hash 与路径）。
- 局域网内明文 HTTP，但同步集不含密钥；文档明确写出这一边界。

---

## 13. 失败模式

| 场景 | 行为 |
|---|---|
| 端口被占 | UDP/TCP 各自 +1 探测（≤10 次），成功后写入状态并在 UI 显示实际端口 |
| 广播被防火墙拦 | 设备列表提示"未发现设备？检查防火墙或添加手动 IP"，附放行命令 |
| 对端版本不兼容 | 只读或拒绝连接，明确提示 |
| 应用失败（YAML 解析/写盘/权限） | 回滚该条目，标 `apply-failed`，可重试 |
| pnpm 缺失/安装失败 | 保留已写文件，依赖回滚到快照，标"需要手动处理" |
| 合并算法异常 | 捕获 → 降级为冲突（绝不覆盖） |
| 时钟漂移 | 用逻辑时钟比较，mtime 仅作展示 |
| 单条目超大 | 跳过并告警，不阻塞其它条目 |
| 状态文件损坏 | 从 `state.json.bak` 恢复；再失败则重建并保留 blobs |

---

## 14. 打包与部署

- npm 包 `dsh-lan-sync`，`exports: { ".": "./lib/index.js", "./client": "./lib/client.js", "./cordis.patch.yml": … }`
- `dsh.bundle.patch` 指向 `cordis.patch.yml`，插入 host 条目；`dsh.client` 声明 `platform: web`
- 依赖：`yaml`（唯一运行时依赖）；测试用 Node 内置 `node:test`
- 首次部署（每台一次）：
  1. `npm pack` 得到 tgz，拷到目标机
  2. `dsh plugin install ./dsh-lan-sync-0.1.0.tgz`（以 CLI 实际语法为准）或手工在 profile `package.json` 加 `file:` 依赖 + bundles + `pnpm install`
  3. 重启 DSH → 设置页出现「局域网同步」→ 填/生成组 ID（同一组所有机器必须一致）
- 升级：同上重复安装；不做自更新

---

## 15. 测试策略

| 层 | 内容 |
|---|---|
| 单元 | 向量时钟支配/并发；深合并（对象/数组/删除）；diff3（重叠/插入/删除/CRLF）；YAML Document 定位与改写（保注释）；签名与验签、重放；路径互译；scope 判定；文件名合法性 |
| 集成 | 两个引擎实例跑 127.0.0.1（临时目录、静态 peer、关闭 UDP）；场景：同组自动握手 → 首次接入 → 单边改 → 双边改不同字段 → 双边改同字段（冲突）→ 解决三种动作 → 回滚 → 断线重连补拉；另测：异组互不可见、错 groupKey 被拒、换组后重接入 |
| 假时钟 | 注入可控时钟，验证并发判定不依赖真实时间 |
| E2E | Windows 本机 + WSL 实例：同机探针发现、跨平台 skills 同步、平台变体隔离（需要 `wsl.exe` 执行权限；当前沙箱拦截，实施时申请） |
| 手工 | 真机装插件、改配置、看 HMR 重载、拔网线重连 |

测试夹具可直接用现成的两份 patch：`C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml` 与 `.wsl-dsh-setup/stage/cordis.patch.yml`。

---

## 16. 里程碑

| 阶段 | 产出 | 验收 |
|---|---|---|
| M1 引擎内核 | 采集、store、时钟、合并、冲突（无网络） | 单测全绿；两个 store 目录做纯逻辑同步 |
| M2 传输与发现 | UDP、HTTP、组内握手、签名、清单/blob | 集成测试：同组自动入组并同步条目；异组隔离 |
| M3 应用层 | patch/skill/dep 写入、快照、回滚、pluginManager 接入 | 集成测试：真文件落地 + 回滚 |
| M4 GUI | 设置页、冲突 diff、向导、侧边栏 | 手工：本机操作全流程 |
| M5 跨平台 | scope 变体、路径互译、EOL/权限、同机探针 | WSL E2E |
| M6 打包 | tgz、安装脚本、README、故障排查 | 目标机一次安装成功 |

---

## 17. 实现前需确认（不改变本设计）

1. `settings.section` 这个设置页 seat 能否被第三方注册（名字已确认，无本机实例；实现时用 `ctx.slots.inject` 探测，失败退回 `plugins.item` 卡片）
2. ~~`ctx.webServer.register` 的路由与鉴权~~ —— 已确认：`register({kind, path, handler})`，无全局鉴权，路由内自调 `ctx.connection.requestRejection(req)`
3. ~~`ctx.pluginManager` 可否直接调用~~ —— 已确认服务方法齐全、门槛只在 tool 层；仍需实测从 Host 插件内调用 `installBundle` 的行为
4. `configEditor.edit` 能否新增尚不存在的 entry（决定 9.2 主/备通道的使用比例）
5. HMR 对 patch.yml 写入的重载时延，用于"应用完成"判定
6. `dsh plugin install <tgz>` 的确切 CLI 语法
7. `/v1/join` 的双向 HMAC 握手与 per-peer secret 分发需在实现前定稿（含测试向量），这是"同组即自动入组"的安全根基

---

## 附录 A：协议报文

```jsonc
// GET /v1/info
{ "v": 1, "nodeId": "n_a1b2c3", "name": "win-desktop/web", "platform": "win32",
  "profile": "web", "dshVersion": "0.2.1-rc.5", "groupTag": "9f3c1a77d2e405b8",
  "joinedAt": 1762390000000 }

// GET /v1/manifest?since=0
{ "v": 1, "nodeId": "n_a1b2c3", "ts": 1762398000000, "more": false,
  "items": [ { "key": "config:mcp-engram@win32", "kind": "config", "scope": "win32",
               "clock": {"n_a1b2c3": 7}, "hash": "sha256:…", "baseHash": "sha256:…",
               "deleted": false, "pinned": false, "updatedAt": "2026-11-06T03:00:00Z" } ] }

// POST /v1/notify
{ "v": 1, "items": ["config:mcp-engram@win32"], "blobs": ["sha256:…"] }

// POST /v1/pair
{ "v": 1, "code": "482913", "nodeId": "n_b0f3e1", "name": "wsl-u22/web",
  "platform": "linux", "dshVersion": "0.2.1-rc.5" }
→ { "v": 1, "secret": "<base64 32B>", "nodeId": "n_a1b2c3", "name": "win-desktop/web" }
```

## 附录 B：样例条目

Windows 侧（现状）：

```yaml
- id: mcp-engram
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    command: node
    cwd: 'F:\desktop\destiny'
    env:
      ENGRAM_BIN: 'C:\Users\Administrator\.local\bin\engram.exe'
```

拆成条目后：scope=`win32`，key=`config:mcp-engram@win32`，blob 为
`{"id":"mcp-engram","name":"@deepseek-ai/dsh-mcp-client","config":{"command":"node","cwd":"F:\\desktop\\destiny","env":{"ENGRAM_BIN":"C:\\Users\\Administrator\\.local\\bin\\engram.exe"}}}`。

WSL 侧同一条目为 `@linux` 变体，两者互不覆盖；若 Windows 侧把 `cwd` 改成 `{{USER_HOME}}/destiny` 且 `ENGRAM_BIN` 改成 `{{USER_HOME}}/.local/bin/engram`，则 scope 变为 `any`，对称同步到两个平台并在各自展开。
