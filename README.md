# dsh-lazy-tools

按需加载工具与技能的 DSH 插件：保留一小份**常驻**核心工具，把其余能力收进一个 `toolbox` 入口。

## 它解决什么

DSH 会把每个可见工具的 schema 注入每次请求。工具越多，提示越长，即使这一轮只用得上一两个。

但「全藏起来」不是解法：模型不会多问一次，它会**绕路**——起一个 shell、写个脚本、或者猜。
一次绕路是好几轮请求，而它省下的那行 schema 是几十个 token。所以本插件只藏长尾：

```
常驻（原生、直调）：read  write  edit  apply_patch  glob  grep  bash  todo_write
                     PTC 组合存在 run_code 时也常驻
按需（一个入口）  ：mcp 集成、媒体、网络、一次性插件工具 ……
```

## 工作机制

1. **核心工具 eager**：上表那些工具保持原生可见，直接调用，不经过工具箱。
   它们覆盖了绝大多数任务的第一个动作，所以通常不存在「首次工具调用」的额外成本。
2. **长尾收窄**：插件为每个 agent 调一次 `ctx.tools.restrict({ allow: ['toolbox', ...eager] })`，
   这是注册表自带的按 agent 收窄接口，提示装配、会话回放与 UI 呈现都保持一致。
3. **目录带签名**：`{action:"list"}` 给出 `read(path:str, offset?:int)` 这样的**带类型参数签名**，不只是散文描述。
   预算不够时**先截短签名、再降成前缀计数**：`ego_click(selector:str, …)` 仍然可以直接调，
   而 `ego_*`（37 个）不能——降级顺序按"还能不能调用"排，不按"省不省字符"排。
   短枚举直接写在签名里（`action:"list|call"`），签名通常已经够直接调用，`{action:"schema"}` 只留给签名不够的场合。
4. **不绕过策略**：`{action:"call"}` 通过插件自己的 `ToolExecutionPipeline` 重放调用，
   审批、guard、超时、post-execute 策略与结果渲染全部照常生效。

5. **失败即带 schema**：`call` 被拒时，答案里附上该工具的参数表；参数表超过 3000 字符时不再展开，
   而是给出 `{action:"schema", tools:[...]}` 指针，避免模型盲目重试。
6. **未知工具给近似项**：拼错时返回最接近的三个名字，而不是让模型回到 `list` 从头找。

## 稳定性取舍

这是一个降低 token 占用的插件，但第一目标是**不改变会话行为**。因此三处主动放弃优化：

| 放弃的 | 换来的 |
| --- | --- |
| 按步骤动态裁剪可见工具 | 提示前缀字节稳定，上下文缓存不失效 |
| 会话内提升/降级工具 | 同上；且模型不会被「先调工具再干活」带偏 |
| 语义检索工具（BM25 / 向量） | 无额外依赖、无常驻索引、行为可预测 |

短会话（1–2 轮）里本插件未必划算：工具箱自身约 400 token，要摊到后续请求上才回本。
工具多的长期会话才是目标场景。

## 0.3.2 审查修复

第二轮审查只修契约、检索与重复计算，不新增可见面：

- **`skills: false` 真正关闭技能**：以前只隐藏目录，`skill` 动作仍能加载正文；现在动作明确拒绝，系统提示里的技能行也一并省略。
- **PTC 组合下的 `run_code` 常驻**：默认工作集补上 `run_code`，有该工具的 PTC 组合不再先绕一次工具箱；没有该名字的部署自动跳过。
- **`list` 的 query 检索完整描述**：以前只匹配 96 字符的显示摘要，描述后半段命中的工具会被误报为不存在。
- **无 `type:"object"` 的 JSON Schema 包装**：只有 `properties` + `required` 也能正确读出签名，`$id` 等包装元数据不再导致误判；真正的 `properties` 参数不会被当成包装。
- **签名按注册表代次缓存**：重复 `list` 不再为每个工具重新投影 schema；`tools/change` 会清空 `schema` 块缓存，原地改定义也不会返回旧块。
- **`plugins` 只有一份总预算**：四个方法 × 三个服务不再各自等 1.5 秒（最坏约 18 秒）；超时即停、拒绝换下一个方法、非数组形状继续探测而不是误报 0 个插件。
- **输入容错**：非字符串 `query` 不再让目录崩溃；`schema` 会去空白、去重、忽略非字符串名字；空白 `tool` 在查找前拒绝；分组标签保留分隔符（`mcp_*` 与 `mcp.*` 不再合并）。
- **token 估算纳入韩文**：韩文音节按 CJK 计价，不再当成 ASCII。

## 0.3.1 可靠性修复

0.3.0 的冻结工作集不变，这一版只修「会算错、会卡住、会给出半截答案」的地方：

- **预算按 token 计**：`catalogTokenBudget` 现在就是估计 token（CJK 一字≈1 token，其余 0.25）。
  旧实现把 1200 当字符再 ×4 折算，中文目录实际会被低估约 4 倍；现在 1200 真的落在 1200 token 以内。
- **签名整字段截断**：超过 160 字符时整个参数丢弃并标 `…`，不会出现半个参数名；支持 JSON Schema
  包装形状，并把类型与短枚举写进签名（字符串枚举带引号，数字/布尔枚举保留类型）。
- **技能发现 2 秒上限**：技能服务不回答时 `list` 照常返回，并明确写「超时」，而不是伪装成「没有技能」。
- **工具目录与技能目录共享一个预算**：`catalogTokenBudget` 是整次 `list` 的上限，表头与提示先预留，
  技能目录只拿剩余额度，避免两份目录各自花满 1200。
- **schema 答案保持完整 JSON**：单块放不下就点名剩下哪些工具，另起一次 `schema` 取；不再截到 JSON 中间。
- **等待期间不串代次**：`list` 在 `await` 技能目录后若注册表已变化，会按新代次重建行，不会旧签名配新计数。
- **参数容错**：`call` 接受带空白的工具名，以及以 JSON 字符串传入的 `arguments`。
- **withheld 数字按每条 schema 计量**：表头的中文低估一并消失。

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
    eager:                       # 常驻原生、不进工具箱；支持通配符如 read_*
      - read
      - write
      - edit
      - apply_patch
      - glob
      - grep
      - bash
      - todo_write
      - run_code                 # PTC 组合存在时；普通组合自动跳过
    # eager: false              # 全部收进工具箱，只留工具箱一张 schema
    catalogDescriptionChars: 96  # 目录每行摘要长度
    catalogTokenBudget: 1200     # 一次 list 的估计 token 上限（CJK 感知）；超了自动降级
    hideOthers: true             # false = 只加工具箱、不收窄视图
    skills: true                 # 目录里是否包含技能，并开放 skill 动作
```

`eager` 里注册表没有的名字会被自动跳过，所以同一份配置可以跨部署使用。
`keep` 是 `eager` 的旧拼写，仍可读；`keep: false` 等价于 `eager: []`。

## 动作一览

| action | 参数 | 结果 |
| --- | --- | --- |
| `list` | `query?` | 工具名 + 参数签名 + 一行摘要；技能目录 |
| `schema` | `tools: string[]` | 这些工具的完整 JSON 参数 |
| `call` | `tool`, `arguments` | 走完整策略管线执行该工具；失败时附参数表 |
| `skill` | `skill` | 该技能的完整说明正文（`skills:false` 时禁用） |
| `plugins` | — | 已安装插件清单（名称 + 启用状态） |

## 行为边界

- **失败开放**：工具箱自身未注册成功时，插件不收窄视图（否则 agent 会失去全部能力），下一步重试；
  连续失败 3 次后保持全开，不再打扰注册表。
- **仅模型可见面**：收窄作用于模型可见的工具集；工具本身仍注册在组合里，插件互不干扰。
- **只装一次**：可见面在会话内安装一次后不再改写，提示前缀稳定。
- **技能目录**：系统提示里的 `<available_skills>` 仍由 `@deepseek-ai/dsh-tool-skill` 注入；
  本插件只把技能**正文**改为按需加载。要压目录本身，调它的 `catalogDescriptionMaxLength`。
- **PTC 模式**：在 PTC（`run_code`）组合下同样生效——`run_code` 与常驻工具一起原生可见，SDK 只列常驻工具与工具箱。
- **approval**：`call` 会触发与该工具直调完全相同的审批流程，不会被静默绕过。
- **不裁剪真实结果**：`call` 与 `skill` 返回原文；只有 `list`/`schema`/`plugins` 有字符预算。
- **递归护栏**：工具箱嵌套调用最多 6 层。

## 开发

```bash
bun test tests/                     # 51 个用例：目录格式化 + 装配/收窄/分发/自纠错
node scripts/measure-first-call.mjs # 40 工具模拟 profile：常驻/目录/窄查询的 token 实测
```

`lib/catalog.js` 是零依赖的纯函数，`lib/index.js` 只负责服务接线。
`.github/workflows/tests.yml` 在 push 到 `main` 和每个 PR 上跑语法检查、测试与测量。
