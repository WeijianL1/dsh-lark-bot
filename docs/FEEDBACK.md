# 回复评价 / Message feedback

此 fork 提供可选的回复评价功能。设置 `DSH_LARK_FEEDBACK=true` 后启动对应
bridge profile 即可开启，默认关闭。适用于之后发送的普通文字、图片和文件。
短 Markdown 回复在原卡片底部同一行显示 👍 / 👎；长回复、带 @ 的回复、纯文本、
图片及文件保持原格式，并附一张引用原消息的评价卡。投票单位是完整回复或文件，
不是每个句子或流式片段。控制卡、审批卡、实时过程卡和历史会话投影卡不添加评价。

同一用户对同一内容只有一张有效票，可以改票，重复点击不增加票数。卡片通过飞书原生
按钮的 primary 样式和 ✓ 显示最近投票人的选择，同时显示姓名（通过回调或缓存的群成员列表获取；不可用时显示“投票用户”，不显示 ID）
与 👍/👎 总票数。这是共享卡片状态，不是每位查看者的独立 toggle；多人操作时最新收到的
卡片更新决定显示，服务器上的各人票数独立保存。重复点击可刷新显示。

👎 立即记录，并在原卡片展开可选原因输入框（最多 1000 字），无需切换私聊。
提交后同一卡片显示作者姓名和最多 200 字的原因预览，完整原因保存在服务器；群内其他人可以看到预览。
其他投票人先点自己的 👎 再提交，不能借用别人的表单。改为 👍 后自己的旧表单失效，
旧原因清除。卡片更新可能清空其他成员正在填写但未提交的文本。
需要现有的 `card.action.trigger` 回调订阅，不再额外发送原因私聊。
旧评价卡点击后可更新为新交互；旧私聊原因表单失效，之前私聊保存的原因不会自动公开。
默认只记录评价。可选的文字修正与定期记忆功能见 [反馈闭环](FEEDBACK_LOOPS.md)。
卡片更新送达顺序受网络影响，磁盘记录是投票真源。

反馈保存在 `<DSH_LARK_HOME>/profiles/<bridge-profile>/feedback/<id>.json`。
每条记录包含原消息 ID、评价卡消息 ID、聊天 ID/类型、内容类型、文字快照
（最多 100000 字符）或文件名、投票用户 open_id、当前票、更新时间、可选原因。
不复制文件二进制内容。目录权限 0700、记录权限 0600；重启保留数据，原子写入和
文件锁防止并发覆盖。只保存每人的最新票，改票会替换旧原因。没有自动清理；
管理员应按自己的保留策略备份或删除目录。删除记录后对应旧卡片不能继续投票。
这些文件包含私人反馈，应保留在服务器状态目录，不提交到 Git，也不上传到日志。
服务器管理员可直接读取 JSON 汇总；本版本没有公开的群内排行榜或管理网页。

投票和原因提交均检查当前用户/群聊白名单，并验证卡片、用户和原消息绑定。
存储故障时不显示“保存成功”；文件或原始消息已送达后，附加评价失败不会触发重复发送。
超出卡片字节预算时使用原生消息加评价卡，卡片格式被明确拒绝时回退；网络超时不盲目重发。

## English

Enable this fork's optional feature with `DSH_LARK_FEEDBACK=true` before starting
the bridge profile (off by default). It covers newly sent normal text, images,
and files. Short Markdown answers include thumbs up/down side by side in the card; long or
mention-bearing answers, literal text, images and files retain their native
format and receive a companion card replying to the original message. One vote
covers a complete response/file, not a sentence or streaming chunk. Control,
approval, live process and historical session-projection cards are excluded.

Each user has one current vote and may change it; repeated clicks do not add votes.
Native primary button styling plus a checkmark highlights the latest named voter
(from the callback or cached chat roster; a generic “Voter” label if unavailable, never the raw ID), alongside total up/down counts. This is shared card state,
not a per-viewer toggle. Each person's vote remains independently persisted;
network delivery order determines the visible update. Clicking again refreshes it.

Downvotes are saved immediately and expand an optional input in the original card
(up to 1000 characters). Submission displays the author’s name and a shared preview of up to 200
characters; the complete reason is stored on the server. No DM is sent. Other
voters click their own down button first; they cannot submit someone else's form.
Switching to up invalidates that voter's old form and clears their reason.
Updates may clear another member's unsubmitted draft. Existing card-action
callbacks are required. Old feedback cards upgrade when clicked; legacy DM forms
are invalid and previously private reasons are not automatically published.
Feedback is storage-only by default. Optional text revisions and scheduled memory
review are described in [Feedback loops](FEEDBACK_LOOPS.md). Persisted records
remain authoritative if card updates arrive out of order.

Records live under `<DSH_LARK_HOME>/profiles/<bridge-profile>/feedback/<id>.json`:
original/control message IDs, chat ID/type, item kind, text snapshot (up to
100000 characters) or filename, voter open_id, current vote, timestamps and
optional reason. File bytes are not copied. Directory/file permissions are
0700/0600. Atomic writes and file locks preserve concurrent votes across
restarts. Only the current vote/reason is retained. There is no automatic
retention: administrators own backups/deletion. Deleting a record invalidates
its card. Keep these private files out of Git and logs. Administrators can read
the JSON for analysis; there is no public leaderboard or management UI.

Current user/group allowlists and message/actor bindings are checked for votes
and reasons. Failed persistence is not acknowledged as success. A companion
card failure cannot turn a delivered file into a retry. Oversized cards use
native delivery; definitive format rejection falls back, ambiguous timeout does not.
