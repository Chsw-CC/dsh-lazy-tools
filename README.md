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
2. **按需读取**：`{action:"list"}` 给出工具与技能的名称加一行摘要；
   `{action:"schema"}` 只取真正要用的那几个 schema；`{action:"skill"}` 读取技能正文。
3. **不绕过策略**：`{action:"call"}` 通过插件自己的 `ToolExecutionPipeline` 重放调用，
   审批、guard、超时、post-execute 策略与结果渲染全部照常生效。

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
    hideOthers: true             # false = 只加工具箱、不收窄视图
    skills: true                 # 目录里是否包含技能，并开放 {action:"skill"}
```

## 动作一览

| action | 参数 | 结果 |
| --- | --- | --- |
| `list` | `query?` | 已加载工具与技能的名称 + 一行摘要 |
| `schema` | `tools: string[]` | 这些工具的完整 JSON 参数 schema |
| `call` | `tool`, `arguments` | 走完整策略管线执行该工具 |
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

## 开发

```bash
bun test tests/      # 17 个用例：目录格式化 + 装配/收窄/分发/提升
```

`lib/catalog.js` 是零依赖的纯函数，`lib/index.js` 只负责服务接线。
