# MAIN 受信任执行边界

> 状态：现行规范
> 事实源：`src-tauri/src/trusted_execution.rs`、`src-tauri/src/network_guard.rs`、`src-tauri/src/harness/permissions.rs`、`src-tauri/src/lib.rs`。

## 两道不同的门

TypeScript 的用户审批回答“用户是否授权这类动作”；Rust 的受信任执行回答“即将执行的具体动作是否仍满足结构、路径、网络和进程安全约束”。用户批准不能跳过 Rust 复核，Rust 也不替代 TypeScript 的产品审批与恢复策略。

这个边界不是 OS / capability filesystem sandbox，也不是全进程出站防火墙。Rust 能保证已经接入 root 级 `trusted_execution` / `network_guard` 模块的 MAIN 文件 API、工作目录、Shell 路径和应用管理的网络请求经过下述复核；任意获准执行的外部程序仍可能自行解释参数、配置和内部 I/O。需要进程级绝对隔离时，必须另行引入操作系统沙箱或容器，不能从本契约推导出来。

## Workspace 路径

Rust 先 canonicalize 工作区根目录，再解析请求路径：

- 现有路径必须 canonicalize 后仍位于工作区根目录；
- 允许新建的路径会先寻找最近的现有父目录，canonicalize 父目录后再拼回缺失部分；
- 工作区外的绝对路径、`..`、平台前缀和经 symlink 逃逸的路径被拒绝；resolver 只在绝对路径明确位于原始或 canonical workspace root 下时把它转换为工作区相对路径；
- 真实 mutation 前必须重新校验路径身份，不跨越无关 await 长期持有旧解析结果。

生产文件入口通过 `resolve_existing_path()` / `resolve_write_path()` 进入同一个 root resolver。主要工作区、临时文件、附件、Image Studio 输出和 MCP workspace 写入会在真实 mutation 前调用 `revalidate_write_path()` 或现有目标复验；新文件使用 `create_new`，原子写入在临时文件创建和 rename 前分别复验。MCP `filesystem.*` 与 Unity 工作区资产路径通过 `workspace_path()` 复用同一 resolver。

mutation-adjacent revalidation 能显著缩窄 symlink/rename 竞态窗口，但在没有 OS capability 的情况下不能数学上消除外部 TOCTOU。文件删除等高风险操作仍需要自己的最终目标复核；没有迁移到统一入口的功能也不能仅凭模块名称宣称受到同等约束。

## Shell 结构与权限

`inspect_shell_command()` 在规则匹配前解析整条命令及每个 segment。受信任 Shell 拒绝：

- NUL、多行、未闭合引号或不完整转义；
- 命令替换、变量展开、后台执行和不支持的控制操作符；
- 嵌套 shell、`eval` / `source`、命令内 `cd` / `pushd` / `popd`；
- 绝对路径、home 展开、`..` 路径逃逸；
- heredoc、文件描述符、process substitution 等危险重定向；
- 非工作区相对的重定向目标。

结构检查通过后，`PermissionGuard` 再结合 `.MAIN/permissions.yaml`、默认规则和精确 approval 决定 allow、ask 或 deny。策略匹配不能只检查整串文本的第一个命令；每个 pipeline / `&&` / `||` / sequence segment 都需要决策。

内置 `run_command`、普通 Agent PTY 输入、hooks、MCP `git.*` / `terminal.run` 和 runtime verifier 在执行前共享 `prepare_trusted_shell_execution()` / `execute_trusted_shell()`：它们重新解析命令、验证 canonical 工作目录，并对可识别为路径或已经存在的 argv 目标及每个重定向目标做 workspace / symlink containment。该检查只约束 shell/argv 中 MAIN 能识别的路径；它不能证明任意外部程序的全部内部文件访问都留在工作区内。

## 命令执行结果与回收

一次性命令返回结构化结果：command、success、exit code、stdout、stderr、timed out、duration，以及 stdout/stderr 各自的 truncation 标志。受信任 Shell 默认分别保留最多 1 MiB stdout 和 1 MiB stderr，任一流被截断都必须独立标记。

超时不是简单丢弃 Future。Unix 下命令在独立进程组中运行；超时时 Rust 终止完整进程组并 wait/reap 主进程。内置 `run_command` 也对输出做上限控制，并把开发服务器、watch 等长驻命令引导到 PTY。

命令非零退出、超时或 MCP permission failure 都是操作级证据。MCP 权限拒绝保留为 `success=false, resultKind=blocked` 的结构化结果和 Trace；TypeScript 必须把它纳入恢复或 `completed(resultKind=error|partial|blocked)`，不能创建应用级 `run.failed`。

## PTY

PTY 以 `sessionKey` 隔离，提供 spawn、write、resize、增量读取、tail、status 与 close。写入完成命令时仍经过 Shell permission preflight。

`close_pty` 先从管理器移除精确 Session，再 shutdown、kill/wait 子进程，返回 `sessionKey`、是否实际关闭、pid 与 exit code。关闭不存在的 key 是幂等 no-op，不得误杀其他 Session。

## 应用管理的网络请求

已经迁移的 `proxy_request` / detailed proxy、chat stream、`web_search` / `web_fetch` / raw fetch，以及 Image Studio 的 engine check、proxy 和远程图片下载都使用 root `network_guard`。这些入口按 exact-origin grant 校验：scheme、规范化 host 和有效 port 必须全部匹配。

- 默认只允许无内嵌凭证的 public HTTP(S) 目标；DNS 为空、混有私网/loopback/link-local/metadata 地址时 fail closed。
- 用户明确配置的本地模型或本地 MCP origin 可以获得窄范围 local grant，允许 loopback、RFC1918 或 IPv6 ULA；metadata、link-local、multicast 与 unspecified 地址仍被拒绝。
- caller 提供的 header 名和值先做严格解析；`Host`、`Content-Length`、`Transfer-Encoding`、`Connection`、`Proxy-Connection`、`Keep-Alive`、`Upgrade`、`TE`、`Trailer` 与 `Expect` 由 trusted transport 唯一管理，caller 设置任意一个都 fail closed。
- 每个 DNS 结果在连接前重新验证并 pin 到实际连接；每个 redirect hop 都重新解析、校验和 pin，降低 DNS rebinding 风险。
- reqwest 自动重定向关闭；最多逐跳处理 8 次，每一跳重新做 origin、DNS 与地址校验。
- 同源跳转沿用原 exact-origin grant。跨 origin 跳转只能为新的 public origin 建立不继承本地例外和凭证的窄 grant；HTTPS 不得降级到 HTTP，未改写为 GET 的请求体不得跨 origin 转发。跨 origin header 不使用“只删已知密钥”策略，而是只保留 `Accept`、`Accept-Language`、`Accept-Charset`、`User-Agent`、`Range`、`Cache-Control`、`Pragma`、`If-Match`、`If-None-Match`、`If-Modified-Since`、`If-Unmodified-Since` 和 `Content-Type`；认证、Cookie、API key、`Origin` / `Referer` 及未知自定义头全部剥离。
- curl 仅是首个已授权目标的有界传输兜底：不自动跟随重定向、禁用代理，并用已验证地址固定 DNS 解析。

网络拒绝使用 `NETWORK_GUARD_DENIED` 边界返回给上层。上层可以换策略或给出受阻结论，但不能自动放宽 origin。

## 变更验证

修改受信任执行层时至少覆盖：

- path traversal 与 symlink escape；
- 多 segment Shell、展开、nested shell 和 redirection；
- 非零退出、双流截断、超时后的进程组回收；
- PTY key 隔离与 close 幂等；
- DNS 混合答案、metadata 地址、本地模型例外；
- caller 路由/分帧 header 拒绝，redirect 逐跳校验，以及跨 origin safe-header allowlist。

确定性证据如何固化见 [测试、Trace 与 Replay](TESTING_AND_REPLAY.md)。
