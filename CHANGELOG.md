# Changelog

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
