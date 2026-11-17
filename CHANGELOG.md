# Changelog

## 0.3.1

主题是「把 0.3.0 的承诺核实」：四处边界条件会让目录在不该出错的地方出错，修完再谈性能。

- **关键字同名的参数不再被吞**（`lib/catalog.js`）：`pattern` / `type` / `format` 既是 schema 元数据键，
  也可能是工具的真实参数名。原实现只按名字过滤，一个名为 `pattern` 的必填参数会从签名里消失，
  签名又不带 `…`，模型照着签名调用就会漏参数。现在按形状判断：值像 descriptor 就保留。
- **内联 schema 与目录共用一份预算**（`lib/index.js`）：原来只判断 schema 段自身是否超预算，
  行文本已花掉的钱没算进去，`catalogTokenBudget: 1200` 时 300 + 1100 可以各自通过、合并超支。
  现在按完整响应的剩余预算判定，放不下就给出 `{action:"schema"}` 指针。
- **一次 list 只描述一个注册表代次**（`lib/index.js`）：行在 `await listSkills()` 之前渲染完毕，
  等待期间 `tools/change` 替换工具会留下「旧签名 + 新 schema」两套契约。现在用 `generation`
  计数器比对，代次变了就按新注册表重建，再渲染内联 schema。
- **schema 投影按定义对象缓存**（`lib/index.js`）：`schema` 动作与内联 schema 会反复投影同一份定义，
  现在用 `WeakMap<definition, block>` 缓存；定义被替换就是另一个对象，缓存自然失效，不会串 schema。
- **测量脚本按命中行计费**（`scripts/measure-first-call.mjs`）：窄查询成本原本拿固定的 `bash`
  schema 当样本，而 `bash` 并不匹配 `query:"read"`，数字偏大；fixture 里前 12 个工具还存在重名。
  现在名字唯一，只累计命中行的 schema，并分别打印命中数、是否内联、以及中文 profile 的结果。
- **提示词去重与压缩**：`toolbox` 描述里同一句 "Their schemas are NOT loaded into this prompt"
  拼了两遍，删掉重复；目录 header / footer 各压缩若干 token，每次 list 都省。

复测（40 工具，35% 中文）：list + schema ≈ 1242 → 已知参数 1 次往返；`list{query}`+call ≈ 178；
不熟悉 list+call ≈ 1042。中文为主：1559 → 672 / 458。测试 42 → 46 条。

## 0.3.0

主题是「首次工具调用」：惰性目录不该向模型收两次问路费，也不该因为目录降级把模型逼到绕开工具。

- **`list` 带参数签名**：每行从工具自身 schema 推导 `(path:str, limit?:num)`，枚举参数直接写成
  `action:"list|schema|call"`。看一次目录就能发起调用，不必再取 `schema`。
- **窄查询内联 schema**：`{action:"list", query:"…"}` 命中不超过 `listSchemaLimit`（默认 3）时，
  末尾直接附完整 schema；这块单独计入预算，放不下就说清楚放不下。
- **参数被拒时附 schema**：`call` 的 `arguments` 被 `prepare` 拒绝、或工具自身报的是参数类错误时，
  原错误文本之后紧跟该工具的完整 schema，一次修正即可。`autoSchema: false` 可关。
- **未知工具名给最近的名字**：`call`/`schema` 的未命中不再只是一句 unknown tool，而是带上最接近的
  1–3 个已加载名字（前缀 → 子串 → 分词重叠），一次修正即可。
- **降级目录给出出口**：tier 3 结果明确写「这是名字普查，不足以发起调用」并指向 `query`；
  tier 2 说明摘要被丢、签名仍在。
- **预算按 token 计**：目录预算改用估计 token 判定，CJK 按 1 字 ≈ 1 token。改动前按「4 字符 = 1 token」
  估算，一个 40 工具的中文 profile 实测 1375 token 却记在 1200 的预算上；改动后同一目录 668 token——
  先缩短摘要（下限 18 字符），仍不够才丢摘要，并在结果里写明。
- **技能发现 2 秒上限**：技能提供方不答时如实报「技能目录不可用」，既不拖住第一次调用，
  也不伪装成「没有技能」。
- **系统提示重写**：从 9 条压到 7 条，加入直调优先、工具名与指令一致、以及「工具能产出答案或产物时
  必须调用，不得凭记忆作答、手写工具输出」。既省一次往返，也省每次请求都要付的提示。

稳定性上不改动既有语义：按 agent 原子替换收窄、失败开放、`call` 结果不裁剪、递归护栏、
`use`/`release` 幂等全部保留。测试 26 → 42 条。

## 0.2.0

对照同类插件（见 README 的「同类插件」一节）后做的三处优化：

- **分层目录（tiering）**：`list` 不再固定输出「名称 + 96 字符摘要」。超过 `catalogTokenBudget`（默认 1200 token）
  就先降成纯名称，再降成按前缀聚合的计数（`mcp_* (37)`）。同类插件里 Hermes 系的 dsh-tool-search
  把这件事做成 0–3 四档，我按同一思路做了三档——目录再大也不会把一次 `list` 变成 2k token。
- **`keep` 支持通配符**：`read_*`、`todo_*` 这类核心工具可以常驻可见。dsh-tool-search 的
  `alwaysVisible` 与 dsh-progressive-tools 的 `alwaysVisible` 都是同样的设计：核心工具保持 eager，
  长尾才走发现。
- **显示被扣下的 token 量**：`list` 首行报 `about N tokens of schemas withheld`，按当前索引内的
  schema 体积估算，索引变更时重算。省了多少是量出来的，不是声称的。

顺带：`use`/`release` 的结果会明说「可见工具列表变了，下一请求开始新的 prompt-cache 前缀」。
dsh-progressive-tools 的核心论点就是工具列表必须字节稳定，否则上下文缓存前缀失效——我们不放弃
`use`，但把代价写在模型看得见的地方。

测试 22 → 24 条。

## 0.1.1

性能与稳定性梳理。三处是行为修正，不只是重构：

- **修复：`call` 会截断工具真实结果。** 之前 `call` 的输出走统一的 24000 字符裁剪，
  等于把 `read`/`bash` 的真实返回切掉一截再交给模型。现在 `call` 与 `skill` 不裁剪，
  只有 `list`/`schema`/`plugins` 这类目录型输出才有预算。
- **修复：视图替换不是原子的。** 之前先释放旧 `restrict()` 再装新的，中途抛错会让 agent
  停在「完全没有收窄」的状态。现在先装新限制、再释放旧的，失败时旧限制原样保留。
- **修复：目录未命中会一直重算。** `tools.definitions()` 每次调用都重建 scope 视图；
  现在按 `tools/change` 缓存名称索引，重复的 `list`/`schema` 不再重建 Map。

其它：递归护栏、`use`/`release` 幂等、inventory 探测 1.5 秒上限、技能提供方抛错隔离、
单条 schema 的 description 限 600 字符但参数树保持原样。测试 17 → 22 条。

## 0.1.0

首个版本：`toolbox` 单一入口 + `list`/`schema`/`call`/`skill`/`plugins`/`use`/`release`。
