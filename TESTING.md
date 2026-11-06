# 测试与联调报告 — dsh-lan-sync

日期：2026-11-06

## 1. 自动化测试

```bash
cd dsh-lan-sync
npm test        # node --test "test/**/*.test.js"
```

结果：**78 通过 / 0 失败**（Node v24.18.0，Windows）。

| 套件 | 覆盖 |
|---|---|
| `clock` | 向量时钟的支配、并发、合并、自增 |
| `diff3` | 行级三方合并：单边改、不同行、同处冲突、插入冲突、删除 vs 修改、无基线、CRLF |
| `merge` | 配置对象深合并、同键冲突、删除 vs 修改、数组原子、依赖版本冲突、bundle 顺序合并与冲突 |
| `patch` | `cordis.patch.yml` 读写：保留注释、保留 `!!js`、insert 子项、新增/删除、空文档 |
| `store` | blob 内容寻址、原子持久化、peer/group/conflict |
| `collector` | 配置行、依赖、bundle、pnpm-workspace、目录技能与单文件技能的采集与哈希 |
| `crypto` | 组密钥派生、groupTag、HMAC 签名、篡改/过期/重放拒绝 |
| `transport` | 入组握手、错误组 ID 拒绝、未签名请求 401 |
| `engine` | 扫描版本、远端更新采纳、并发不同字段合并、同字段冲突、删除、墓碑哈希删除 |
| `applier` | 配置写盘+快照、技能写入+权限、依赖/ bundle 钩子、回滚 |
| `peer-address` | 多地址候选与回环降级 |
| `host`（集成） | 两台实例真实 HTTP：入组、配置传播、并发冲突 |
| `api`（集成） | 设置页路由：status、组、短组 ID 拒绝、设置、冲突列表 |

## 2. Windows ↔ WSL 真机联调

环境：

| 侧 | 系统 | DSH | 地址 |
|---|---|---|---|
| Windows | Windows 10/11 | 0.2.1-rc.5（3080） | 插件端口 56701 |
| WSL | Ubuntu (WSL2) | 0.2.1-rc.2（3081） | 插件端口 56702 |

过程与结果：

1. **自动发现/自动入组**：两边写入同一个组 ID 后，Windows 通过「同机探针 + 端口扫描」发现 WSL 的 56702；WSL 通过默认网关地址发现 Windows。双方 `peers.json` 均自动生成，无需人工确认。✅
2. **Skill 同步 Windows → WSL**：在 Windows 新建 `~/.dsh/skills/lan-sync-e2e/SKILL.md`，约 20 秒后 WSL 出现相同内容。✅
3. **Skill 修改 WSL → Windows**：WSL 端追加一行，Windows 端在下一轮同步后收到。✅
4. **配置新增 Windows → WSL**：Windows patch 新增 `lan-sync-e2e-probe` 条目，WSL 的 `cordis.patch.yml` 出现同一条目（第 146 行）。✅
5. **配置删除 Windows → WSL**：Windows 删除该条目后，WSL 上的条目消失（grep 计数 0）。✅
6. **冲突队列**：首次对接时，两边已存在且没有共同基线的条目没有互相覆盖，而是进入冲突队列（Windows 侧观察到 4 条 `no-common-base` 冲突），符合「首次对接不覆盖」的设计。✅
7. **删除与本地修改的边界**：WSL 改过 skill 后 Windows 删除该 skill，WSL 判定为 `delete-vs-modify` 冲突而非静默删除。随后实现「墓碑记录被删版本哈希」修复：当被删哈希正好是本机当前版本时，删除直接生效。✅
8. **跨平台变体隔离**：Windows 的 `@win32` MCP 条目没有被 WSL 采纳，WSL 的 `@linux` 条目也没有覆盖 Windows；两侧各自维护自己的变体。✅

联调中发现并修复的问题：

- WSL 无法通过 `127.0.0.1` 访问 Windows 插件 → 新增「对端地址候选列表 + 逐个回退」和「组内广播地址」。
- `discovery: false` 时同机探针不运行 → 探针从广播分支中移出，独立运行。
- 首次对接会覆盖本机已有条目 → 改为按 peer 记录共同基线，无基线一律进冲突。
- 删除旧版本时本地刚改过会被判冲突 → 墓碑记录 `removedHash`。
- HMR 卸载时 `server.close()` 可能被 keep-alive 连接卡住 → 关闭前 `closeAllConnections()`。

## 3. 尚未验证

- **真实浏览器 UI**：`lib/client.js` 通过语法检查与 stub-React 渲染测试，注册了 `settings.section` / `main` / `sidebar.panellist`，但未在真实浏览器里点击验证。需要重启 DSH 后在设置页确认一次。
- DSH 版本号上报：插件目前无法从运行环境取到 DSH 版本，`/v1/info` 里的 `dshVersion` 显示 `0.0.0`；版本兼容门禁因此未启用。
- 符号链接形式的技能目录未做专门处理（当前按普通目录遍历）。
