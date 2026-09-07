# 反馈闭环 / Feedback loops

## 开启

保留 `DSH_LARK_FEEDBACK=true`，并按需启用：

```dotenv
DSH_LARK_FEEDBACK_REPAIR=true
DSH_LARK_FEEDBACK_MEMORY=true
```

两项默认关闭，需要以插件方式运行在 DSH profile 内，使用该 profile 的 `agent-default-model`
及已有认证。宿主模型服务通过 Cordis 可选依赖注入绑定，服务卸载后释放引用，重新加载后重绑。单独 CLI 启动而没有宿主模型服务时，不启用闭环。评价区用分隔线、灰色小标题和
并排按钮与正式回答区分；原因仍在卡内填写并标注作者。

## 根据原因修正回答

- 单独点 👎 只记录投票；提交非空原因后，按钮回调原子保存原因和修正意图。
- 后台每 30 秒检查一次；同一回复、投票人和相同原因对应一个任务，重复提交不重复生成。
- 使用原回答、原因和能够精确绑定到原消息的原问题快照生成完整修正版。修正版回复原消息，
  保留原回答；修正版也带评价按钮。不会因为生成了修正版而自动继续修正，必须有新的人工反馈。
- 当前实现是**文字回答修正**，不执行 shell、浏览器、文件或其他工具；图片/文件的反馈可以得到
  解释和改进建议，但不能据此声称附件已重新生成。证据不足时应说明缺口，不臆造核实结果。
- 模型调用前和发布前都检查当前投票版本、原消息绑定和白名单。改票或撤销访问会取消未发布结果。
- 生成结果先落盘，再发消息。发送使用固定 UUID。失败或进程中断不会盲目重新生成/重发；
  任务状态和已生成结果可供管理员检查。现阶段没有卡内“重试失败任务”管理按钮。

## 定期筛选、写入与读回

每天 **北京时间 04:00** 后第一次后台检查，按用户、聊天、工作区分别处理未审阅的原因版本。
服务停机错过时间时，恢复后补做当日批次；没有新反馈时不调用模型。每个范围每天至多一个批次，
最多 20 条新反馈，并带上最多 20 条已审阅记录供重复经验比对。只有开启后能精确绑定原工作区的
记录参与自动记忆整理；不会猜测旧消息属于哪个项目。

筛选模型仅提出候选，不拥有工具。代码再检查：

- 来源必须是该批次真实、仍有效且有权限的反馈；不能引用虚构来源。
- 只接受工作习惯/流程经验和明确偏好；至少由两条不同回复的反馈支持，或用户明确表达长期要求
  （例如“以后请”“请记住”“always include”）。单次“答得不好”不直接变成长久规则。
- 排除未核实的事实性断言、个人身份、临时任务细节、秘密、猜测和来源不足的候选；每批至多 5 条。
  语义判断仍由模型完成，代码门槛不是事实真伪证明。
- 写入前再检查来源是否已改票、撤回或失去权限。

使用真实 `mnemon remember` 写入，通过写入回执确认；相同范围、相同经验带稳定来源哈希，
写入前先查询防重。CLI 用独立参数调用，不拼接 shell。默认使用 `MNEMON_DATA_DIR`
（未设置时为默认工作区的 `.mnemon`）和 `MNEMON_CLI_PATH`（默认 `mnemon`）。

每个 `(bridge profile, workspace, chat, actor)` 对应独立的
`lark-feedback-<hash>` Mnemon store。**不会切换现有默认 store，也不会把某位群成员的偏好
应用给其他人。** 后续普通消息会从对应 store 读回最多 8 条、4000 字符的经验，作为有范围的
辅助上下文；当前用户指令优先。读回失败时普通对话继续。

## 保存位置和状态

评价仍在 `<bridge-profile>/feedback/<id>.json`。
闭环任务及审阅报告、生成结果、写入回执位于：

```text
<bridge-profile>/feedback/loop/tasks/<task-hash>.json
```

文件 0600、目录 0700，跨进程锁保护单 worker；反馈卡回调不等待模型。任务状态为
`pending/running/completed/failed/interrupted/cancelled`。`completed` 的记忆任务表示审阅结束，
**只有 `receipts` 中的真实记忆回执才说明写入了内容**，空候选不会假装写入成功。
报告包含原回答和反馈，保持在服务器私有状态目录，不提交 Git 或输出日志。无自动删除策略。
模型使用最长 180 秒的取消信号，CLI 写入最长 30 秒；关闭服务会取消当前生成并等待清理。

关闭对应环境变量并重启即可停止该闭环；已有投票、任务和 Mnemon 数据保留。

## English

Enable `DSH_LARK_FEEDBACK_REPAIR` and/or `DSH_LARK_FEEDBACK_MEMORY` alongside feedback.
Both default off and require the in-process DSH model service, using its configured default model and authentication.
Submitting a downvote reason durably requests one text revision; a bare downvote does not. The original remains intact,
and the revision replies to it with its own controls. No tools execute during generation; attachments are not regenerated.
Repeated identical submissions are deduplicated. Current vote and authorization are checked before generation/publication.

Daily review runs after 04:00 Asia/Shanghai, at most once per user/chat/workspace each day, with bounded new evidence and
historical supporting feedback. A tool-less model proposes reusable lessons; code verifies source IDs, support and basic
secret gates. Two distinct answer records or an explicit enduring human preference are required. Unsupported facts,
personal identities and transient details do not qualify. These gates do not constitute independent fact verification.

Mnemon CLI writes into isolated `lark-feedback-<hash>` stores keyed by profile/workspace/chat/actor, without changing the
active store. Stable provenance keys and real receipts provide deduplication and auditability. Subsequent messages recall
only their matching store (up to 8 entries / 4000 characters). Current instructions take precedence; recall failures do not
block ordinary conversation. Tasks/reports/receipts remain private under `feedback/loop/tasks`. Interrupted or ambiguous
operations are not blindly rerun. A completed review with zero receipts means no new memory was written.

可启用[对话学习](CONVERSATION_LEARNING.md)，将后续聊天与按钮原因放入同一队列；有新聊天时采用空闲批次并维护旧偏好的替代关系。
