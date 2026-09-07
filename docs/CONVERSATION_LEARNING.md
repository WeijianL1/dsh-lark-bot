# 对话学习 / Conversation learning

对话学习模块随现有宿主插件加载，复用反馈队列和 Mnemon CLI 存储，不需要升级 DSH 或安装另一套数据库。
按钮原因和自然语言反馈进入同一个筛选流程。即时聊天纠正仍由主 Agent 正常回答；学习任务不发送第二份回复。

## 开启与已有 Mnemon 的关系

```dotenv
DSH_LARK_FEEDBACK=true
DSH_LARK_FEEDBACK_MEMORY=true
DSH_CONVERSATION_LEARNING=true
```

对话开关默认关闭。需要在同一个 DSH profile 内运行宿主插件和模型服务。
本模块使用 Cordis 注入的 `agents` 和 `llm` 服务；只监听实际根 Agent，从开启后的新回合开始，不扫描历史聊天。
飞书支持当前 Web adapter 的消息关联路径；本地 Web 支持有 RPC 来源、未绑定飞书的会话。
SDK/ACP 子进程不在此宿主监听范围内。飞书绑定会话中无法确认发言人的输入跳过，不猜测归属。

Mnemon 0.5.2 自带 guided idle review。启用本模块作为统一自动学习者时，把该 profile 的 Mnemon
配置设为 `writebackMode: off`，避免旧的会话级自动复盘把群成员偏好写进共享 USER 记忆。
保留 `writeEnabled`、已有记忆、读取和明确调用的记忆工具。此配置由管理员部署时设置，插件不会自行改其他插件配置。

## 捕获与范围

- 通过 `agent/pre-step` 读取 `source.kind=user` 的原始用户消息；跳过插件注入、子 Agent、命令和超长消息。
- 飞书身份来自发送前记录的 RPC 关联和持久 JobLedger。提取未经记忆扩展的用户正文，校验会话、工作区和发言人。
  同时检查普通 SessionStore 和显式投影绑定；关联丢失时不能退回 local-owner。
- 本地 Web 记为当前安装的 `local-owner`，只在 `local-web` 范围内使用，不与任何飞书用户自动合并。
  该约定面向单所有者本地 Web；多用户 Web 部署需先提供真实认证主体映射。
- 完成回合后原子保存用户原话及同一用户、同一聊天的上一个回答摘要，附带会话和消息 id。助手自己说“成功”不是用户反馈。
  混合发言人的回合不把共同回答归给某一个人。插件自己的记忆注入不会再次被学习。
- 明确消息 id 去重；结束前没有完成的回合不进入学习。重启后旧的未完成捕获不会自动重放。

所有学习和读取按 `(bridge profile, workspace, chat, actor)` 隔离。项目经验也保留用户范围，不自动升级为整个群或全局规则。
同一用户的不同线程可积累同一聊天范围的经验，但原回答上下文只来自原会话；线程上下文不会凭空拼接。

## 空闲复盘和筛选

完成回合后空闲至少 2 分钟才可复盘；同一范围两次对话批次至少相隔 5 分钟。新回合开始会阻止后台写入，
新消息到来会使已过时批次取消并重新收集。每批最多 20 条新证据、20 条历史支持、5 条候选。
无新证据不调用模型。只有按钮反馈时仍保留北京时间 04:00 后的每日批次。

模型只提出结构化候选，没有工具执行权。代码要求真实来源，聊天候选还必须引用用户原话：

- 明确长期偏好可以由一次表述支持，例如“以后请先给结论”。
- 没有明确长期要求的经验需要两条不同记录支持，由模型判断是否是同一可复用问题。
- “这次”“暂时”、普通感谢、空泛不满、秘密、没有依据的事实、模型自行推测的偏好不能成为长期规则。
- 新旧偏好冲突时，只允许引用当前范围内的已有经验 id，并要求用户有明确的长期变更或纠正证据。
- 写入前再次检查来源、飞书权限和对话是否继续；语义判断仍依赖模型，原话引用并非事实正确性的证明。

## 写入、替换和读回

使用 `mnemon remember` 的真实回执确认写入，并记录来源。新经验写入后，旧经验的撤销意图与版本记录一同落盘，
再通过 `mnemon forget` 软删除被明确替代的旧条目；数据可追溯，不直接删除数据库。
已保存的撤销意图会在后台继续执行，即使此前的 CLI 失败或进程重启，也不重新运行筛选模型。
待撤销和已撤销条目从本模块的读回中排除。A→B→A 会恢复 A 的新回执并保存旧版本来源。

飞书沿用已有的按用户范围读回；本地 Web 用 `source.kind=plugin, form=recall` 的辅助上下文注入。
每次最多读取 8 条、4000 字符；当前用户要求优先。读回失败不阻塞正常对话。

原始证据位于 `<bridge-profile>/feedback/learning/conversations/<hash>.json`；
经验及版本位于 `feedback/learning/lessons/<scope-hash>.json`；模型报告和写入回执继续位于
`feedback/loop/tasks/<hash>.json`。目录 0700，文件 0600。原话不写日志或 Git。当前没有自动过期删除策略。
跨数据库写入和本地日志不是一个事务；尚未拿到并记录回执的异常操作保留任务用于诊断，不伪称完成。

## English

An opt-in host lifecycle module unifies explicit votes and conversational feedback using the existing worker and Mnemon backend.
It captures actual root-agent human messages after completed turns, binds Feishu speakers through transport receipts, and isolates
local Web as a single local owner. Missing Feishu attribution fails closed. No extra correction message is sent by this module.

Idle reviews debounce for two minutes, with a five-minute minimum batch interval. Evidence, direct quotations, durable-intent/support
and current-access checks gate model proposals. Scope remains profile/workspace/chat/actor. Versioned native write receipts and
recoverable soft-retirement intents track corrected preferences. Model semantics are not independent verification.

Set the existing Mnemon plugin's `writebackMode: off` when using this as the unified automatic learner; explicit memory tools and
existing read paths remain available. The module does not alter another plugin's configuration itself.

Design references: [Letta dreaming](https://docs.letta.com/configuration/memory),
[LangMem delayed processing](https://langchain-ai.github.io/langmem/guides/delayed_processing/),
[Hindsight evidence consolidation](https://hindsight.vectorize.io/developer/observations).
