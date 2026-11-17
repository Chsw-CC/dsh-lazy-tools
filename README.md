# dsh-lazy-tools

按需加载工具与技能的 DSH 插件：把「每个工具一份 JSON schema 常驻系统提示」换成**一个** `toolbox` 入口。

## 它解决什么

DSH 会把每个可见工具的 schema 注入每次请求。工具越多，提示越长——即使这一轮只用得上其中一两个。
这个插件让模型先看到一份紧凑目录，按需取 schema、按需调用：

```
before:  read(1200 tok) + write(900) + bash(1500) + edit(1100) + web(800) + …  ≈ 每条请求都付
after:   toolbox(约 400 tok) + 目录（按需） + 实际用到的 schema（按需）
```

## 工作机制

1. **窄化视图**：插件为每个 agent 调用 `ctx.tools.restrict({ allow: ['toolbox', ...keep] })`，
   这是注册表自带的按 agent 收窄接口，因此提示装配、会话回放与 UI 呈现都保持一致。
2. **按需读取**：`{action:"list"}` 给出工具与技能的名称、**参数签名**和一行摘要；
   `{action:"schema"}` 只取真正要用的那几个 schema；`{action:"skill"}` 读取技能正文。
3. **不绕过策略**：`{action:"call"}` 通过插件自己的 `ToolExecutionPipeline` 重放调用，
   审批、guard、超时、post-execute 策略与结果渲染全部照常生效。

## 首次工具调用的成本

惰性目录的代价曾经是「用一个工具要三次往返」：

```
list（目录） → schema（参数） → call（执行）
```

每一步都是一次完整的模型往返，而 `list`/`schema` 的输出会永久留在会话里——越晚调到真正的工具，
上下文越贵。0.3.0 把这条路径压到 1–2 步，且**不靠放宽可见工具集**：

| 场景 | 路径 | 步数 |
| --- | --- | --- |
| 已知工具名与参数名 | `call` 直调 | 1 |
| 知道能力、不确定参数名 | `list {query:"…"}`（命中 ≤ `listSchemaLimit` 时内联这些工具的完整 schema）→ `call` | 2 |
| 不知道有哪些工具 | `list`（每行带参数签名）→ `call` | 2 |
| 猜错工具名 | 报错附最近的名字 → `call` | 2 |
| 参数写错 | 报错附该工具的完整 schema → `call` | 2 |

所以惰性目录省的是**常驻 schema**，不再向模型收「先问两轮」的路费。只有 `use` 会改可见列表，
也只有它付 prompt-cache 前缀重算的代价。

一个 40 工具（35% 中文）的模拟 profile，用 `scripts/measure-first-call.mjs` 实测：

| 路径 | 改动前 | 改动后 |
| --- | --- | --- |
| 到达首次真实调用 | list + schema ≈ 1237 token / 3 次往返 | 已知参数：1 次往返；`list{query}`+call ≈ 356 token / 2 次往返；不熟悉：list+call ≈ 1037 token / 2 次往返 |

复现：`bun scripts/measure-first-call.mjs`（同一份 `lib/catalog.js`，不依赖 Harness 运行时）。

### 反绕路：目录降级不能变成放弃工具的理由

压缩目录原本只输出 `mcp_* (37)` 这种名字普查：模型既不能调，也猜不出参数名，最省事的做法就是
绕开工具、凭记忆作答——一次绕路的 token 代价远大于省下的目录体积。因此：

- tier 3 的结果里明确写出「这是一份名字普查，不足以发起调用」，并给出 `{action:"list", query:"…"}`
  的恢复路径；tier 2 也会说明摘要被丢掉、签名仍在；
- 未知工具名随错误一起返回最近的名字，参数被拒时随错误一起返回该工具的完整 schema；
- 系统提示里保留一条硬规则：工具能产出答案或产物时必须调用，不得凭记忆作答、手写工具输出或猜测返回值；
- 技能发现超过 2 秒不再等待，并如实写明「技能目录不可用」——慢提供方不会把第一次调用拖成超时，
  也不会被误读成「没有技能」。

## 安装

```bash
cd <profile>        # 例如 ~/.dsh/profiles/default
pnpm add link:<本目录绝对路径>
```

或在「插件」页用 `plugin_manager` 的 `install_bundle`，spec 用 `link:<本目录绝对路径>`。
本包含 `cordis.patch.yml`，安装后条目自动注册；改配置后重启（或 HMR）生效。

## 配置

```yaml
- id: dsh-lazy-tools
  config:
    toolName: toolbox            # 模型看到的工具名
    keep: []                     # 始终可见、不进工具箱的工具名
    catalogDescriptionChars: 96  # 目录每行摘要长度
    catalogTokenBudget: 1200     # 一次 list 的 token 预算；超了自动降级（摘要 → 纯名称 → 前缀计数）
    catalogSignatureChars: 64    # 每行参数签名的长度上限
    signatures: true             # 目录里是否带参数签名（false = 只列名字）
    listSchemaLimit: 3           # 带 query 的 list 命中不超过几个时，直接内联这些工具的完整 schema（0 = 关闭）
    autoSchema: true             # 参数被拒时，是否把该工具的完整 schema 附在错误后面
    # keep 支持通配符：['read_*', 'todo_*'] 表示这一族核心工具始终 eager
    hideOthers: true             # false = 只加工具箱、不收窄视图
    skills: true                 # 目录里是否包含技能，并开放 {action:"skill"}
```

## 动作一览

| action | 参数 | 结果 |
| --- | --- | --- |
| `list` | `query?` | 已加载工具与技能的名称 + 参数签名 + 一行摘要；带 `query` 且命中不超过 `listSchemaLimit` 时，末尾附这些工具的完整 schema |
| `schema` | `tools: string[]` | 这些工具的完整 JSON 参数 schema；未知名附最近的名字 |
| `call` | `tool`, `arguments` | 走完整策略管线执行该工具；参数被拒时附该工具的完整 schema |
| `skill` | `skill` | 该技能的完整说明正文 |
| `plugins` | — | 已安装插件清单（名称 + 启用状态） |
| `use` | `tools: string[]` | 把这些工具提升为**本会话**常驻可见 |
| `release` | `tools?: string[]` | 撤销提升（省略则全部撤销） |

### 会话级提升

`use` / `release` 直接替换该 agent 的 `restrict()` 结果（返回的 disposer 立即释放），
所以可见集合永远是「工具箱 + 本会话点名要的工具」，不会层层堆叠。
适合工具密集型任务：把 `read`、`bash` 这类真正反复用的提到常驻，其余继续按需。

### 插件清单的来源

`plugins` 依次尝试 `ctx.get('pluginInventory' | 'inventory' | 'pluginManager')` 上的
`listBundles` / `list` / `bundles` / `entries`，把返回结构归一成「名称 + 启用状态」；
若当前组合没有这些服务，则退回工具注册表并如实说明——**不会伪造清单**。

## 行为边界

- **失败开放**：若工具箱自身未注册成功，插件不会收窄视图（否则 agent 会失去全部能力），并在下一步重试。
- **仅模型可见面**：收窄作用于模型可见的工具集；工具本身仍注册在组合里，插件互不干扰。
- **技能目录**：系统提示中的 `<available_skills>` 仍由 `@deepseek-ai/dsh-tool-skill` 注入；
  若目录本身偏大，可调它的 `catalogDescriptionMaxLength`。本插件负责把技能**正文**改为按需加载。
- **PTC 模式**：在 PTC（`run_code`）组合下同样生效——SDK 只列工具箱，其余工具经工具箱调用。
- **approval**：`call` 会触发与该工具直调完全相同的审批流程，不会被静默绕过。
- **不裁剪真实结果**：`call` 与 `skill` 返回原文；只有 `list`/`schema`/`plugins` 有字符预算。
- **原子替换**：新限制先装、旧限制后释放，替换失败时旧限制原样保留，不会出现「裸奔」窗口。
- **递归护栏**：工具箱嵌套调用最多 6 层。
- **签名不臆造**：参数签名从工具自身 schema 推导；推不出来就是空串，那一行与改动前的目录逐字相同。
  截断按「整个参数」丢弃并补 `…`，不会切出半个参数名。
- **预算按 token 计**：`catalogTokenBudget` 用估计 token 判定，中文按 1 字 ≈ 1 token 计。
  改动前按「4 字符 = 1 token」估，一个 40 工具的中文 profile 实测 1375 token 却记在 1200 的账上；
  改动后同一目录 668 token。预算不够时先把摘要缩短到下限 18 字符，仍不够才丢摘要，并如实说明。
- **降级有出口**：目录退到 tier 3 时结果里写明「不足以发起调用」并给出 `query` 恢复路径；
  技能提供方不答时写明超时，而不是显示成「没有技能」。

## 开发

```bash
bun test tests/      # 42 个用例：目录/签名/建议/预算 + 装配/收窄/分发/提升 + 首次调用路径与不变量
```

`lib/catalog.js` 是零依赖的纯函数，`lib/index.js` 只负责服务接线。

## 同类插件

同赛道里做得更早、也更完整的几个：

- [everclear077/dsh-progressive-tools](https://github.com/everclear077/dsh-progressive-tools) — `stable-proxy`：固定请求面、目录留在内存、派发走普通管线；核心论点是工具列表必须字节稳定，否则缓存前缀失效。
- [Letter2025/dsh-tool-search](https://github.com/Letter2025/dsh-tool-search) — Hermes 风格分层披露：0–3 四档，`tool_search`/`tool_describe`/`tool_call` 三件套，核心工具 eager。
- [vibeinging/dsh-tool-search](https://github.com/vibeinging/dsh-tool-search) — 同样用 `ctx.tools.restrict()` 收窄，选中的工具持久化到会话事件，独立的父级过滤仍然优先。
- [Imzl-zl/dsh-toolbox-ui](https://github.com/Imzl-zl/dsh-toolbox-ui) — 面向 MCP 的按服务器延迟加载（ToolSearch），默认关闭。
- [Jesse-njx/dsh-skillport](https://github.com/Jesse-njx/dsh-skillport) — 技能侧的渐进披露索引，正文按需加载。
- [menotbobbybrown/dsh-plugin-mcp](https://github.com/menotbobbybrown/dsh-plugin-mcp) — MCP 桥 + BM25 工具检索 + 动态 token 预算。

本插件的差异：不做语义检索，也不替换执行器。可见面只留一个工具箱，其余靠注册表的
`restrict()` 收窄；`call` 走自己的 `ToolExecutionPipeline`，因此审批与 guard 与直调一致。
代价是每次 `use` 都会改可见列表——上面 dsh-progressive-tools 的论点直接命中这一点，
所以结果里会明确写出缓存前缀失效。
