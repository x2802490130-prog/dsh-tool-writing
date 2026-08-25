# dsh-tool-writing

[![license](https://img.shields.io/npm/l/dsh-tool-writing)](https://github.com/x2802490130-prog/dsh-tool-writing/blob/main/LICENSE)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的「写文引擎」插件：让 harness 具备长篇网络小说的创作能力，并用**独立的 DeepSeek key** 承担「子线程 / 分流 / 多线并行」的生成与检索任务。

一句话定位：**一套把"长篇一致性"做成工程的长篇网文创作系统**——写到几百章，依然记得住设定、接得住伏笔、守得住大纲；每章写完，事实自动入账，欠读者的账自动记账。

## 设计定位

- **主 Agent（harness 自身模型）**：总调度，负责主线叙事、结构、设定、以及「新奇的、出其不意的想法」的决策。
- **本插件（独立 key）**：把重活分流出去——并发生成多章草稿、批量出点子、批量扩写细纲，以及资料检索与一致性筛查。
- **饲料区（书库）**：导入并管理多本小说，建立全文索引，供考据、风格参考与设定借鉴。

## 三件套

| 仓库 | 作用 |
|---|---|
| **dsh-tool-writing**（本仓库） | 写文引擎插件本体（novel_* 工具全家桶） |
| [dsh-writing-remote](https://github.com/x2802490130-prog/dsh-writing-remote) | 宿主侧 Typert remote：向客户端面板暴露项目/书库/检索数据 |
| [dsh-client-ui-writing](https://github.com/x2802490130-prog/dsh-client-ui-writing) | 客户端「写作」面板：项目浏览、书库、全文检索、演化 diff、线索图谱 |

## 核心设计

### 多书隔离：一个工作区 = 一本书
- 引擎项目根按**会话绑定的工作区**解析（`exec.agent.session`），同一实例并发服务多会话互不串书；显式 `projectRoot`（专属预设）优先级最高。
- 所有项目状态（人物/世界/伏笔/演化/风格/台账/索引）按书存储；用量记账带书标记，`novel_usage` 可看每本书的消耗。
- 书库（饲料区）全局共享，所有书可检索同一批标杆。

### 弹性合同：承诺管死、大纲管路、偏离有程序
- **故事承诺书**（`outline/premise.md`）：全书的题（题材承诺/命运承诺/读者承诺/叙事法律），强制注入每次生成，永不违反。
- **正典台账**（`novel_ledger` 五表）：数字锚/信息来源/时间锚/母题密度/**追读力**（钩子类型·强度/爽点/微兑现/欠账——上章欠账未回应前不许开新钩子）。
- **五段写作任务书**（`novel_draft brief=true`）：写前想透——开篇委托/这章的故事（目标·阻力·禁区）/人物/怎么写更顺/**收在哪里**。
- **硬关卡**（`novel_draft gate=true`）：写完自动阻断质检（事实矛盾/承诺违背/欠账未回应/物理硬伤），有问题修复一轮再落盘。
- **章后八项体检**（`novel_audit`）：感知汇聚/多角色体感/断层检测/情感弧线/读者视角/叙述语感/**节奏信号**（钩子同构·爽点密度·断档·欠账）/**AI 味检查**。

### 平台向：起点 + 番茄
- **`novel_market`**：双平台审稿——起点（黄金三章/单章字数/每 3 章爽点/长线伏笔/均订逻辑）、番茄（第 1000 字小爽点/前 3 章打脸/完读率/憋屈时长/爽点密度），输出适配度与改造清单。
- **`novel_censor`**：发书前敏感自查（涉政/色情擦边/暴力血腥/赌博毒品/封建迷信/现实机构影射/未成年红线）。
- 平台规则与敏感自查框架为**全局技法卡**（`$DSH_HOME/global-techniques/`），所有书生成时自动注入。

## 工具集（48 个）

### 开书与规划
| 工具 | 作用 |
|---|---|
| `novel_brief` | 引导式开书：模糊需求 → 澄清问题清单（带选项与影响）→ 完整开书方案（书名/简介/卖点/金手指/人设/大纲/读者承诺） |
| `novel_init` | 初始化小说项目（元信息 + 自动铺骨架） |
| `novel_scaffold` | 体检补全工程骨架（非破坏式，空目录一键初始化） |
| `novel_outline` | 生成/展开主线、分卷、章节细纲（可并行） |
| `novel_check` | 全环节体检 checklist（骨架/设定/台账/索引/活目录） |

### 创作核心
| 工具 | 作用 |
|---|---|
| `novel_lore` | 人物/世界观/时间线/伏笔设定卡增删改查（带演化史） |
| `novel_brainstorm` | 并发生成 N 个新奇点子（金手指/反转/钩子/冲突） |
| `novel_draft` | 起草一章（可选 brief 任务书 + gate 硬关卡，支持分卷） |
| `novel_continue` | 从最近章节结尾自然续写下一章 |
| `novel_batch` | 并发生成多章草稿（多线任务分流） |
| `novel_polish` | 润色/改写（不改变情节与信息） |
| `novel_simulate` | 深度推演引擎（心理/因果/交汇/反常识意外） |
| `novel_choice` / `novel_decision` | 人机共创决断点（选项+利弊，人做美学决断） |
| `novel_research` | 资料检索/考据，归纳成笔记 |
| `novel_export` | 导出全书为单个 Markdown/TXT |

### 一致性体系
| 工具 | 作用 |
|---|---|
| `novel_ledger` | 正典台账五表（数字锚/信息来源/时间锚/母题密度/追读力），scan 自动更新 |
| `novel_audit` | 章后八项体检（含节奏信号 + AI 味检查） |
| `novel_market` | 平台审稿（起点+番茄双视角 + 改造建议） |
| `novel_censor` | 发书前敏感自查（六大类+红线） |
| `novel_review` | 一致性审校（人物/剧情/时间线/设定矛盾） |
| `novel_foreshadow` | 伏笔回收追踪（登记/回收/未回收清单） |
| `novel_evolution` | 设定/人物演化追踪（auto 检测 + 手动 + diff 陈旧检测） |
| `novel_threads` | 多线叙事与线索图谱（登记/交汇/停滞提醒） |
| `novel_sync` | 章末自动编排（摘要→设定抽取→状态回写→演化检测→伏笔提醒→活目录） |
| `novel_distill` | 长文本蒸馏为结构化精华（含保留校验） |
| `novel_handbook` | 生成给人读的导航手册（世界观/人物/时间线/伏笔/导读） |
| `novel_style` | 风格指纹（剖析/多档案/自动注入所有生成） |
| `novel_organize` | 杂乱设定归纳整理（自动分类/冲突标记/待定收件箱） |
| `novel_proofread` | 机械校对（错别字/标点/的地得/重复词/数字格式） |
| `novel_plan` | 连载计划（完本目标/每日产出/存稿余量） |
| `novel_usage` | 用量总账（按模型/按书/按日期，含估算费用） |

### 检索与书库
| 工具 | 作用 |
|---|---|
| `novel_search` | 项目 + 书库联合全文检索 |
| `novel_semantic` | 按「含义」检索（概念索引召回 + 字面召回 + LLM 重排） |
| `novel_vsearch` | 纯概念向量检索（cosine 分数，免 LLM） |
| `novel_embed` | 构建/补全语义概念索引（增量、断点续传） |
| `novel_library_import/list/read/delete/search` | 饲料区书库管理（.txt/.md/.epub，自动分章） |
| `novel_library_analyze` | 书库拆解（总览/人物/世界观/情节/爽点/风格/金句，分批增量） |

## 快速开始

### 1. 安装

```bash
git clone https://github.com/x2802490130-prog/dsh-tool-writing
# 把 lib/ 与 cordis.patch.yml 放入 <DSH_HOME>/profiles/node_modules/dsh-tool-writing/ 并重启 harness
```

### 2. 配置 key（多 key 拆刀，可选）

插件使用独立于主 Agent 的 DeepSeek key（`DSH_WRITING_API_KEY`），可进一步按角色拆分：

| 环境变量 | 角色 |
|---|---|
| `DSH_WRITING_API_KEY` | 主 key（必配） |
| `DSH_WRITING_DRAFT_KEY` | 起草通道（可选，回退主 key） |
| `DSH_WRITING_POLISH_KEY` | 润色通道（可选，回退主 key） |
| `DSH_WRITING_SYNC_KEY` | 同步/深任务通道（可选，回退主 key） |

### 3. 开一本书

```
1. 新建工作区（一个工作区 = 一本书），在会话里说「开新书，我想写……」→ novel_brief 引导澄清 → 完整方案
2. 方案确认后 novel_init 建骨架（或直接 novel_init 书名 题材 主角 金手指）
3. novel_outline 搭大纲 → novel_lore 建设定 → novel_draft brief=true gate=true 写第一章
4. 每章写完 novel_sync 自动编排；定期 novel_audit 八项体检；novel_ledger scan 追读力
5. 发书前 novel_market 平台审稿 + novel_censor 敏感自查
```

## 数据安全

- 仓库 `.gitignore` 排除所有项目数据文件（章节/设定/状态/索引/台账）——**内容不上传，饲料由插件用户自备**。
- 代码内无硬编码密钥；凭据全部来自宿主环境变量注入。
- 语义检索使用 DeepSeek 概念索引（LLM 抽取概念词，无需第三方 embedding key）；如显式配置有效 embedApiKey，仍可用稠密向量。

## 版本历史

| 版本 | 主要变化 |
|---|---|
| **v0.8.0** | 弹性合同体系：故事承诺书注入/追读力台账/五段任务书/硬关卡/八项体检（节奏信号+AI味）；平台审稿 novel_market + 敏感自查 novel_censor；全局技法库落地；引导式开书 novel_brief；多书隔离（工作区感知）；用量按书记账 |
| v0.7.0 | 工作区注册制、会话隔离重构、四查注入、全链路 maxTokens 20000 |
| v0.6.x | 饲料区功能蒸馏、写作提醒段、校对数量检查 |
| v0.5.x | 追读力 v5.3、长期记忆闭环 |

## 协议

MIT。设计思想借鉴自 [webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer)（GPL v3，仅思想不抄码）、[Phase-Fiction](https://github.com/nanzhipro/phase-fiction-skill)、[chinese-webnovel-skills](https://github.com/tance-mang/chinese-webnovel-skills)，感谢这些项目。
