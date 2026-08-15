# dsh-tool-writing

[![npm version](https://img.shields.io/npm/v/dsh-tool-writing)](https://www.npmjs.com/package/dsh-tool-writing)  [![license](https://img.shields.io/npm/l/dsh-tool-writing)](https://github.com/x2802490130-prog/dsh-tool-writing/blob/main/LICENSE)

面向 DeepSeek Harness 的「写文引擎」插件：让 harness 具备长篇网络小说的创作能力，并用一把**独立的 DeepSeek key** 承担「子线程 / 分流 / 多线并行」的生成与检索任务。

## 设计定位

- **主 Agent（harness 自身模型）**：总调度，负责主线叙事、结构、设定、以及「新奇的、出其不意的想法」的决策。
- **本插件（独立 key）**：把重活分流出去——并发生成多章草稿、批量出点子、批量扩写细纲，以及资料检索与一致性筛查。
- **饲料区（书库）**：导入并管理多本小说，建立全文索引，供考据、风格参考与设定借鉴。

## 工具集

### 创作核心
| 工具 | 作用 |
|---|---|
| \`novel_init\` | 初始化小说项目（元信息 + 目录骨架） |
| \`novel_outline\` | 生成/展开主线、分卷、章节细纲（可并行） |
| \`novel_lore\` | 人物/世界观/时间线/伏笔的增删改查 |
| \`novel_brainstorm\` | 并发生成 N 个新奇点子 |
| \`novel_draft\` | 起草一章正文（综合设定+大纲+前文，支持分卷） |
| \`novel_continue\` | 从最近章节自动续写下一章 |
| \`novel_batch\` | 并发生成多章草稿（分流/多线） |
| \`novel_polish\` | 润色/改写 |
| \`novel_review\` | 一致性审校（检索前文+设定，筛查矛盾） |
| \`novel_research\` | 资料检索/考据，归纳成笔记 |
| \`novel_status\` | 查看项目进度（分卷/章节/字数） |
| \`novel_export\` | 导出全书为单个 Markdown/TXT |
| \`novel_summarize\` | 生成章节情节摘要，写入可检索的情节日志 |
| \`novel_setting_extract\` | 从正文自动抽取人物/世界观/伏笔到 lore/ |
| \`novel_foreshadow\` | 伏笔回收追踪（登记/回收/查未回收） |
| \`novel_brief\` | 模糊需求一键开书（一句话 → 完整方案） |
| \`novel_distill\` | 蒸馏文本为精华 + 保留校验（项目/书库，含全书语义召回） |
| \`novel_handbook\` | 生成给人读的导航手册（含语义召回名场面） |
| \`novel_simulate\` | 深度推演引擎（心理/因果/交汇/反常识意外） |
| \`novel_semantic\` | 混合语义检索（向量召回+字面召回+LLM 重排，按含义而非字面） |
| \`novel_vsearch\` | 纯向量语义检索（cosine 相似度，免 LLM，快速看命中） |
| \`novel_embed\` | 构建/补全语义向量索引（增量、断点续传、内容变更自动重嵌） |
| \`novel_evolution\` | 设定/人物演化追踪（auto 检测 + 手动 + 历史 + 版本 diff 陈旧检测） |
| \`novel_threads\` | 多线叙事与线索图谱（登记/交汇/图谱/停滞提醒） |
| \`novel_style\` | 风格指纹（剖析文风、多风格档案、自动注入所有生成） |
| \`novel_decision\` | 人机共创决断点（选项+利弊，人做美学决断） |
| \`novel_sync\` | 章末自动编排（摘要+抽取+演化+伏笔提醒 一键） |
| `novel_usage` | 用量总账：调用次数、token 与估算费用（落盘 $DSH_HOME/writing-usage.json，自动裁剪） |
| `novel_proofread` | 机械校对：只找硬伤（错别字/标点/的地得/重复词/数字格式），不改文风 |
| `novel_plan` | 连载计划：完本目标/每日产出/存稿余量/排期登记（本地 plan.json，不对接平台） |

### 饲料区 + 扩展检索
| 工具 | 作用 |
|---|---|
| \`novel_library_import\` | 导入小说（.txt/.md/.epub，自动识别编码 + 自动分章） |
| \`novel_library_list\` | 列出书库所有小说 |
| \`novel_library_read\` | 读某本小说的某一章 |
| \`novel_library_delete\` | 删除已导入的小说 |
| \`novel_library_search\` | 书库全文检索（SQLite FTS5 trigram + LIKE 混合） |
| \`novel_search\` | 扩展检索：项目 + 书库 联合全文检索 |

语义向量检索使用百炼 \`text-embedding-v3\`（1024 维，复用 DASHSCOPE_API_KEY，零新增成本）：\`novel_embed\` 建索引（增量可续传，内容变更自动作废重嵌），\`novel_semantic\` 混合召回，\`novel_vsearch\` 纯向量；无 key 时自动退化为字面检索。

## 思考档位路由（V4 三档）

- 引擎 `generate()` 支持 `effort: low | high | max`：`low`/默认走主模型（deepseek-v4-flash）并**显式关闭思考模式**（V4 官方默认开思考，会吃掉输出额度且不支持 temperature）；`high`/`max` 走 `deepModel`（deepseek-v4-pro）并开启思考 + 对应档位
- 工具路由：草稿/续写/批量/润色/校对/检索重排 → low；一致性审校/设定抽取/蒸馏校验/演化检测/剧情决断/书库拆解/章末编排 → high；`novel_simulate` 深度推演 → max
- 兼容旧调用：`deep: true` 等价 high（不上 wire 参数，行为不变）
### 缓存前缀布局（批量省钱）

- 批量生成（`novel_batch`）每个请求的 `system` 与共享上下文（作品信息+设定卡片+大纲+最近章节）逐字节一致，章节差异只出现在提示尾部；`generateMany` 默认**先串行首任务预热缓存**，其余并发时自动命中
- DeepSeek 前缀缓存自动命中：v4-flash 命中价 $0.0028/M、v4-pro $0.003625/M（约为未命中价的 1/50~1/120），批量 10 章的费用大头只在首次请求
- 有回归测试锁死该布局（`smoke-cache.mjs`）：共享前缀在前、章差异在尾，防止未来改动破坏缓存友好性
## 用量记账与连载计划

- `novel_usage`：查看独立 key 的调用总账（次数/输入输出 token/缓存命中/估算费用，按模型与最近 7 天汇总）。明细落盘 `$DSH_HOME/writing-usage.json`（上限 2000 条自动裁剪），单价可按需覆盖。
- `novel_proofread`：机械校对某一章，输出「片段 | 问题类型 | 建议改为」清单，绝不改写文风、不重写句子。
- `novel_plan`：项目根 `plan.json` 的本地连载计划——`set-goal` 设定章数/字数/完本日期后自动算每日产出；`schedule`/`mark-done` 登记排期；存稿余量按 manifest 实际章节联动。不做平台发布对接，发布由作者自行粘贴。

## 项目目录约定

\`\`\`
novel.json               # 作品元信息 + 分卷/章节进度
lore/                    # characters/ world/ timeline/ foreshadowing/ other/
outline/                 # 主线与分卷/章节细纲
chapters/                # 正文（可按分卷建子目录）
research/                # 考据与审校笔记
.writing-index.sqlite    # 项目全文检索索引（SQLite，自动维护）
\`\`\`

书库默认位于 \`$DSH_HOME/writing-library/\`（可配 \`libraryRoot\`）。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| \`apiKeyEnv\` | \`DSH_WRITING_API_KEY\` | 独立 key 的环境变量名/凭证引用 |
| \`apiKey\` | \`""\` | 内联 key（不建议，避免泄露） |
| \`baseURL\` | \`https://api.deepseek.com\` | DeepSeek 端点 |
| \`model\` | \`deepseek-v4-flash\` | 分流用的模型（可用 deepseek-reasoner） |
| `deepModel` | `deepseek-v4-pro` | 深度思考任务（归纳/拆解/蒸馏）用的模型 |
| \`maxConcurrency\` | \`4\` | 并发上限 |
| \`maxTokens\` | \`4096\` | 单次生成最大 token |
| \`temperature\` | \`0.8\` | 采样温度 |
| `embedBaseURL` | `""` | 自定义 embedding 端点（默认百炼 text-embedding-v3） |
| `embedModel` | `""` | embedding 模型名（默认 text-embedding-v3） |
| `embedApiKey` | `""` | embedding 密钥（默认复用 DASHSCOPE_API_KEY） |
| \`projectRoot\` | \`.\` | 小说项目根目录（默认当前工作区） |
| \`libraryRoot\` | \`$DSH_HOME/writing-library\` | 书库根目录 |

## 密钥安全

密钥**绝不硬编码**。优先级：凭证存储（\`$DSH_HOME/.credentials.yaml\` 的 \`DSH_WRITING_API_KEY\`）→ 环境变量 → 内联 config。

## 安装（profile）

\`\`\`
dsh plugin --profile web add file:<本目录>
也可以直接从 npm 安装：`dsh plugin --profile web add dsh-tool-writing`。
\`\`\`

然后在写作预设的 \`agent.cordis.yml\` 中挂载：

\`\`\`yaml
- id: tool-writing
  name: 'dsh-tool-writing'
  config:
    apiKeyEnv: DSH_WRITING_API_KEY
    model: deepseek-v4-flash
    maxConcurrency: 4
\`\`\`
