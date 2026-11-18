# dsh-lazy-tools

把常驻的工具 schema 目录换成**一个** `toolbox` 入口。

真实 profile 实测：**105 个工具、约 36,023 token 的 schema** 不再进入每一次请求。
模型的可见面只留 9 个核心工具，加一个工具箱。

> 省 token 的插件很多，但不少省出一个新毛病：模型开始绕路。
> 它不再调用工具，而是起个 shell、写个脚本、或者凭记忆猜一个参数名。
> 一次绕路是好几轮请求，而它躲开的那行 schema 只有几十个 token。
> 本插件的第一目标不是"少放 schema 进提示"，是**不改变会话行为**。

## 为什么不是全藏起来

假设你把 105 个工具全收进工具箱。模型要读文件，得先 `{action:"list"}` 看到
`read`，再 `{action:"call"}` 调它。两次额外请求，换回一行 schema 的位置。

它不会每次都这么乖。多数模型在这个情境下会**直接走 shell**——那是它早就训练过的路径，
一次就够，而且它确定能用。于是你省下 36,000 token，代价是整场会话换了个范式，
并且每一步都多一次外部进程的失败可能。

所以本插件的取舍是：**核心集常驻，只藏长尾。**

```
原生可见，直接调：read  write  edit  apply_patch  glob  grep  bash  todo_write  run_code
收进 toolbox    ：mcp 集成、媒体、网络、一次性工具 ……
```

左边这些覆盖了绝大多数任务的第一个动作，所以通常**不存在「首次工具调用」的额外成本**：
第一次要调的就是 `read`，而 `read` 就在提示里。注册表里没有的名字自动跳过，
同一份配置可以跨部署使用。

## 省多少

`scripts/measure-first-call.mjs` 用一个 40 工具、中英混合的模拟 profile 实测，
数字来自脚本输出而不是估算：

| 场景 | tokens |
| --- | ---: |
| 常驻 schema（40 个工具全展开） | 6,346 |
| `list` 一次（40 个名字 + 签名，预算 1200） | 672 |
| `list` 带 `query`（命中 5 个） | 213 |
| `schema` 取一个工具的参数 | 205 |

目录本身一次 672，窄查询 213。**只有遇到不认识的工具才付这笔钱**，
付完拿到的是可以直接调用的签名，不是一段散文。

真实 profile 里有 105 个工具，其中 101 个可解析出签名。把这一批真实数据输入渲染器：
**默认 1200 预算下落在 tier 2，1061 token，101 行全带签名**——要求最长的那个工具
（8 个参数，含 7 个可选）被截成 `ego_click(selector?:str, x?:num, …)`，仍然够直接调用。
预算放宽到 2400 才升到 tier 1（摘要 + 签名），说明签名档确实在吃满中等预算，而不是摆设。

## 装

```bash
dsh plugin --profile desktop add github:Chsw-CC/dsh-lazy-tools
```

本地开发用 `link:`：

```bash
dsh plugin --profile desktop add link:/absolute/path/to/dsh-lazy-tools
```

`dsh plugin` 只是把参数转给 profile 目录里的 pnpm。装好后重启 DSH 生效。
仓库自带 `dsh.bundle` 声明与 `cordis.patch.yml`，所以不需要手工改 profile 的 patch 列表；
卸载用 `dsh plugin --profile desktop remove dsh-lazy-tools`。

## 配置

```yaml
- id: dsh-lazy-tools
  config:
    toolName: toolbox             # 模型看到的工具名
    eager:                        # 常驻原生、不进工具箱；支持 * 通配
      - read
      - write
      - edit
      - apply_patch
      - glob
      - grep
      - bash
      - todo_write
      - run_code                  # 没有这个工具的部署会自动跳过
    # eager: []                  # 全部收进工具箱，只留一张 schema
    catalogDescriptionChars: 96  # 目录每行摘要长度
    catalogTokenBudget: 1200     # 一次 list 的 token 上限；超了按下面顺序降级
    hideOthers: true              # false = 只加工具箱、不收窄视图
```

`eager` 里注册表没有的名字会自动跳过，所以同一份配置可以跨部署使用。
`keep` 是它的旧拼写，仍然可读。

## 动作

| action | 参数 | 结果 |
| --- | --- | --- |
| `list` | `query?` | 工具名 + 参数签名 + 一行摘要 |
| `schema` | `tools: string[]` | 这些工具的完整 JSON 参数 |
| `call` | `tool`, `arguments` | 走完整策略管线执行；失败时附参数表 |

## 行为边界

- **失败开放**：工具箱自身没注册成功时不收窄视图（否则 agent 会失去全部能力），下一步重试；
  连续失败 3 次后保持全开，不再打扰注册表。
- **只装一次**：可见面在会话内安装一次后不再改写，提示前缀字节稳定。
- **仅模型可见面**：收窄作用于模型可见的工具集；工具本身仍注册在组合里。
- **不绕过策略**：`call` 走插件自己的 `ToolExecutionPipeline`，审批、guard、超时、
  post-execute 策略与直调完全一致。
- **不裁剪真实结果**：`call` 返回原文；只有 `list`/`schema` 这类目录输出才有预算。
- **递归护栏**：工具箱嵌套调用最多 6 层。

## 和同类插件的差别

同赛道里做得更早、也更完整的几个，都对过一遍：

- [everclear077/dsh-progressive-tools](https://github.com/everclear077/dsh-progressive-tools) — `stable-proxy`：固定请求面、目录留在内存、派发走普通管线。核心论点是工具列表必须字节稳定，否则缓存前缀失效——本插件的"只装一次"直接沿用这条。
- [Letter2025/dsh-tool-search](https://github.com/Letter2025/dsh-tool-search) — Hermes 风格分层披露：0–3 四档，`tool_search`/`tool_describe`/`tool_call` 三件套，核心工具 eager。
- [vibeinging/dsh-tool-search](https://github.com/vibeinging/dsh-tool-search) — 同样用 `ctx.tools.restrict()` 收窄，选中的工具持久化到会话事件，独立的父级过滤仍然优先。

本插件的差异只有一条，但它是设计起点而非事后补丁：

**核心集从一开始就常驻，不是"可以配置成常驻"。** 上面几个都支持 eager 工具，但默认形态仍是
"藏全部 + 按需发现"，因为它们省 token 的动机更纯粹。本插件认为那个默认会把模型推向绕路，
所以默认反过来：`read`/`write`/`edit`/`bash` 这些第一个动作就在提示里，`eager` 只用来**加**不该藏的，
`eager: []` 才是那种形态。

不做语义检索（BM25 / 向量）也是同一个理由：它需要常驻索引或额外依赖，而签名加摘要已经够定位。
少一个索引就是少一处"模型发现不了某个工具"的失败面。

## 已知限制

- **点号工具名不计入签名恢复**。`mcp.server.tool` 这类名字在目录里按分隔符分组，
  用 `query` 逐个前缀取回时可能漏掉；它们仍能在 `list` 里看到分组计数，但没有逐条签名。
- **收窄是模型可见面**。工具本身仍注册在组合里，其他插件照常装配；只是这个 agent 看不到它们。
- **短会话未必回本**。工具箱自身约 400 token，1–2 轮的会话摊不回来，工具多的长期会话才是目标场景。

## 开发

```bash
bun test tests/                      # 55 条：目录格式化、签名截断、装配/收窄/分发/自纠错
node scripts/measure-first-call.mjs # 40 工具模拟 profile 的 token 实测
node scripts/bench-catalog.mjs      # 目录渲染耗时基准（信息输出，不做门禁）
```

`lib/catalog.js` 是零依赖纯函数（格式化与预算规则），`lib/index.js` 只负责服务接线。
目录渲染在 105 工具、默认 1200 预算下约 0.17 ms/次（0.4.0 约 0.73 ms），
40 工具约 0.05 ms/次；这是墙钟耗时，输出与 0.4.0 逐字节一致，token 数不变。
CI 在 push 到 `main` 和每个 PR 上跑语法检查、测试与测量。

MIT
