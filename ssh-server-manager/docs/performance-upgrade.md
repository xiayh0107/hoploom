# Performance upgrade implementation record

The agreed 2026-11-04 plan is preserved below. This record tracks the
implementation, validation and releases. Existing transfer work (`6f469c9`)
provided the starting point for the complete upgrade.

## Delivery checklist

- [x] Reconcile original plan and preserve unrelated in-progress installer changes.
- [x] Linear host indexing/grouping, privacy-aware search, accessible windowing above 200 hosts.
- [x] Bounded directory cache, identity and upload invalidation, retained metadata on refresh.
- [x] Shared operation/execution contract, bounded scheduling and request cancellation.
- [x] Rust/PyO3/Tokio executor with equivalent Python rollback and platform process isolation.
- [x] Native build, platform wheels/sdist, DSH selection and offline cache, installers and CI.
- [x] Doctor/CLI/Skill/API documentation and generated contracts/assets.
- [x] Full behavioral, cancellation, packaging and browser regressions; review against every requirement.
- [x] Publish GitHub native release 0.12.1 and npm plugin 0.3.1 from the same commit.
- [x] Configure the `hoploom` PyPI Trusted Publisher and publish the verified release.
- [x] Prepare, test and publish the Homebrew formula and platform bottles from PyPI's actual sdist.

## Implementation evidence

Implementation checkpoint (2026-11-12): Hoploom 0.12.1's native core is
compiled and used by bounded diagnostics, directory/metadata reads and captured
transfers. Rust/Python share real-process contracts. Shared foreground masters
and immutable request configs have independent owners. Both Windows executors
retain job-member synchronization handles and wait for confirmed descendant
exit before completing cancellation; the real-process assertion repeats ten
times per executor.

Final local evidence: 934 Python passes (8 platform-only skips), 146 frontend
unit tests, all 31 browser cases, and 30 plugin checks with one platform-only
skip, including managed Python download and offline reuse. Source archive
checks, rebuild/install and the populated 0.8.0 upgrade have separate smoke
checks. Rust core tests, fmt/clippy and Windows-target clippy pass.

[PR #22](https://github.com/xiayh0107/hoploom/pull/22) merged the implementation;
[PR #23](https://github.com/xiayh0107/hoploom/pull/23) fixed npm's tarball path
and Windows termination confirmation, then aligned the patch releases at
`8dd09cbb9c66f14d851db21eaf3cf56927d9c353`. Both final main-commit workflows
passed: [Python 3.10/3.13 on macOS/Linux/Windows, Rust and browser
regressions](https://github.com/xiayh0107/hoploom/actions/runs/43331832939), and
[all eight installed native wheels, sdist rebuild/install and three-platform
plugin/prepack checks](https://github.com/xiayh0107/hoploom/actions/runs/43331833066).
Windows also passed the repeated independent native/MSYS credential probes.

[Hoploom 0.12.1](https://github.com/xiayh0107/hoploom/releases/tag/v0.12.1)
contains all eight native wheels, the sdist and complete manifest.
[dsh-hoploom 0.3.1](https://www.npmjs.com/package/dsh-hoploom/v/0.3.1) is
published with GitHub Actions provenance; its
[GitHub release](https://github.com/xiayh0107/hoploom/releases/tag/dsh-hoploom-v0.3.1)
attaches the actual registry tarball. The downloaded package's SHA-512/SHA-1,
all eight wheel SHA-256 values, backend 0.12.1 and source commit were verified.
The final tarball installed and composed successfully in an isolated real dsh
profile. Its UI/client/bridge files are byte-identical to the previously
reviewed real-dsh UI build, so those visual observations remain valid.

The PyPI pending publisher was registered for project `hoploom`, owner
`xiayh0107`, repository `hoploom`, workflow `publish.yml` and environment
`pypi`. Rerun [publish workflow 43332673316](https://github.com/xiayh0107/hoploom/actions/runs/43332673316)
completed successfully; PyPI now serves all eight native wheels and
`hoploom-0.12.1.tar.gz`. The actual sdist URL is
`https://files.pythonhosted.org/packages/6a/2d/e2d43577eceacb26ccaa4b8fc5c19d6b2c905a6677f1b4cc906bcee26ac7/hoploom-0.12.1.tar.gz`
with SHA-256
`cdd4d83ea54166836c5116723cd5fc1b1fa62b92b0176737915ba19da1628d3a`; it
matched the 223-file release candidate byte-for-byte.

[Homebrew tap PR #3](https://github.com/xiayh0107/homebrew-tap/pull/3) passed
the macOS 26, macOS 15 and Linux `brew test-bot` jobs in
[run 43495622465](https://github.com/xiayh0107/homebrew-tap/actions/runs/43495622465)
and was merged. The formula keeps 34 macOS resources plus the Linux-only
`jeepney` and `secretstorage` resources, with `maturin==1.16.0` recorded in
`pypi_packages`. Homebrew style and online audit passed, and a real bottle
fetch succeeded. The tap's bottle release
[hoploom-0.12.1](https://github.com/xiayh0107/homebrew-tap/releases/tag/hoploom-0.12.1)
contains arm64 Sequoia, arm64 Tahoe and x86_64 Linux bottles; the bottle stanza
is on tap main at commit `86d6ed50d874e6aa8f0d277acc00bd82e691ed55`.

All checklist items are now delivered and verified.

# Hoploom 性能与交互体验升级计划

## 1. 目标、架构与已确定的选择

采用 **React 界面 + Python 业务与安全层 + Rust 执行核心 + 系统 OpenSSH** 的架构，分两个可独立发布的里程碑交付。

已确定：

- **统一原生包**：Rust 扩展随 Hoploom 主包发布，支持的平台默认启用；源码构建需要 Rust 工具链。
- **传输在后台继续**：切换页面或文件标签页不终止上传、下载，由应用统一提供状态和取消入口。
- **不设基准测试阶段**：通过功能、资源生命周期、安装兼容性和已有构建检查验收，不设置跑分门槛。
- Python 继续负责 HTTP API、CLI、MCP、SQLite、SSH 策略、凭据和授权。Rust 负责执行与资源管理，OpenSSH 继续负责 SSH/SFTP 协议。
- 本轮不引入桌面外壳，不重写 SSH 协议，不迁移数据库或凭据存储。交互式终端、隧道、挂载及独立凭据验证保留现有执行路径。

本轮直接解决整文件后台缓冲、列表重复计算、取消后工作继续运行、切页丢失传输状态等问题。Python 的基础内存占用仍会存在。

## 2. 第一里程碑：传输、列表和请求生命周期

### 文件传输

- 下载保持“远端接收到私有临时文件 → 检查结果与大小 → 分块发送”的顺序，移除整文件 `read_bytes()`；HTTP 发送块大小为 **64 KiB**。
- 临时目录的所有权交给响应生命周期，在正常结束、客户端断开、发送失败和取消时统一清理；清理放在覆盖整个 ASGI 响应的 `finally` 中，不仅依赖正常发送后的后台任务。
- 上传按 **1 MiB** 分块处理，磁盘写入移出事件循环。传输并发限制在读取上传体之前生效，防止请求先大量落盘再排队。
- 保留 **100 MiB** 单文件上限、CSRF 保护、SFTP 元数据验证、不覆盖发布及显式覆盖语义。取消或断线后，不把远端状态不确定的上传显示为“已回滚”，也不自动重传。
- 浏览器下载采用可取消的响应流读取并报告接收字节，最终生成 Blob 保存。本轮改善后台内存占用，浏览器仍受完整 Blob 和 100 MiB 上限约束。

### 应用级传输管理

- 在 App 层建立内存中的传输管理器，保存任务来源、目标、状态、进度和取消控制器，独立于 Files 页面生命周期。
- 每个界面最多 **2 个活动传输、8 个排队任务**；切页、切换标签页后继续运行。关闭整个页面、嵌入视图释放或会话失效时取消所属任务。
- 使用全局传输栏显示活动和完成状态。下载区分“远端准备”和“浏览器接收”；上传区分“发送文件”和“等待远端结果”。仅在确有字节数据时显示百分比。
- 上传进度通过共享 API 客户端中的 XHR 适配实现，复用现有认证、CSRF、错误处理和嵌入代理规则。
- 任务完成后释放 File、Blob、对象 URL、流和监听器；任务记录不进入 URL、浏览器持久存储或历史状态。
- 上传结果触发来源目录缓存失效；用户返回时刷新来源目录，避免错误刷新当前正在浏览的其他主机。

### 主机列表与缓存

- 使用主机 ID、别名索引和一次遍历完成分组、路由关系与统计，消除分组追加时的数组复制及行内重复扫描。
- 搜索文本按数据版本和隐私模式预计算；输入立即更新，列表过滤使用延迟渲染。隐藏详情时，隐藏字段不参与搜索。
- 超过 **200 台主机**时启用本地窗口化渲染，沿用现有主机行、分组行高度，前后各保留 **8 行**缓冲。
- 键盘游标按主机 ID 保存，移动到未渲染行时先滚动再定位；保留选择、分组、菜单、悬停、屏幕阅读器行索引和行数。
- 文件列表保留现有每批 250 行和缓存优先展示。目录缓存同时限制为 **40 个目录、合计 20,000 条记录**，主机连接身份变化、上传成功和会话结束时失效。
- 本地元数据刷新保留旧内容，合并重复读取，按受影响对象更新。详情打开、焦点恢复和隐藏详情不触发远程检查。

## 3. 执行核心、取消语义与接口

先抽取统一执行接口，由 Python 实现完成第一里程碑，再接入具有相同行为的 Rust 实现。

### 内部接口

| 接口 | 职责 |
|---|---|
| `OperationContext` | 一次用户操作的身份、所属会话、主机、总截止时间和取消状态 |
| `ExecutionSpec` | 已校验的程序、参数、环境、输入、输出模式及缓冲上限 |
| `TaskHandle` | 完成通知、取消、结果领取和同步等待 |
| `ExecutionResult` | 退出码、受限输出、耗时，以及退出、取消、超时、输出超限或启动失败原因 |

- Python 构造命令并执行策略校验；Rust 不读取凭据库，不拼接业务命令，不承担 SSH 信任决策。
- 保留 Windows 原生 OpenSSH 与 Git/MSYS 客户端的参数转义差异，不能直接用 Rust 默认参数序列化替换现有规则。
- Rust 使用 PyO3 进程内扩展和按需初始化的 Tokio 执行器，默认 **2 个工作线程**。异步调用通过完成通知唤醒 Python Future；同步等待释放 Python 线程附着，避免阻塞其他 Python 工作。[PyO3 线程说明](https://github.com/pyo3/pyo3/blob/main/guide/src/parallelism.md)
- 第一轮迁移目录读取、文件元数据、有界诊断及 Web 文件传输。任意命令输出、交互式终端和独立凭据验证不在本轮迁移范围内。

### 并发与取消

- 每个后台进程最多 **8 个活动操作、同一主机 2 个、传输 2 个、排队 64 个**；现有批量检查并发上限仍为 4。子步骤复用父操作额度，避免嵌套等待死锁。
- Web 目录加载使用现有 **45 秒**总期限，覆盖排队、探测和回退；其他操作沿用既有超时配置。用户取消不记录为主机连接失败。
- 请求断开、显式取消、超时和应用关闭都传播到所属执行任务。上传体读取只有一个消费者，断线监听不得竞争读取 multipart 数据。
- POSIX 使用独立进程组，Windows 使用 Job Object 管理请求进程及其子进程；取消后等待退出并回收句柄。
- **共享 ControlMaster 与请求进程分开管理**：既有共享连接不加入请求的终止范围；新建共享连接使用独立生命周期。单个请求取消不得关闭其他任务正在使用的连接。
- 共享探测采用消费者计数；取消一个等待者只解除其订阅，最后一个消费者离开才停止共享探测。
- 清理任务使用独立的短期限，不能被已取消的父令牌直接跳过；只清理本次操作创建的临时资源，不删除远端目标文件。

### 对外兼容

- 保留现有路由、下载 POST、上传 multipart、CLI 名称和 MCP 工具结构；不新增持久任务 API。
- 下载增加准确的 `Content-Length`，嵌入代理转发该头，并将下游取消传播到私有后端。
- 为队列已满和执行器不可用增加结构化 `503` 错误；输出超限使用明确错误码，避免返回部分结果冒充成功。
- 增加 `HOPLOOM_EXECUTOR=rust|python`，默认 `rust`。Python 模式作为显式回滚开关，执行中失败不会自动换执行器重试。
- `doctor --json` 增加执行器诊断信息；普通界面不展示 Rust 实现细节。CLI 帮助、版本和本地清单读取不启动执行器。
- 更新 OpenAPI 契约、生成类型及 CLI、Skill、代理集成文档。

## 4. 第二里程碑：统一原生包与安装链路

### Python 包

- 使用 **PyO3 + maturin**，扩展名为 `ssh_server_manager._native`，保留现有 Python 包目录、CLI 入口和内置前端资源。
- 标准 CPython 采用 **`abi3-py310`**，延续 Python 3.10 起的兼容范围；本轮不新增 PyPy 或自由线程 Python 的预编译支持承诺。[PyO3 分发说明](https://github.com/pyo3/pyo3/blob/main/guide/src/building-and-distribution.md)
- Rust 源码放入产品子树，提交 Cargo 锁文件并固定工具链。Cargo、Python 包版本及网站版本纳入一致性检查。
- sdist 明确包含 Rust 源码、锁文件、Python 源码、前端构建产物及现有公开开发材料；继续排除私有目录、缓存和运行状态。[maturin 混合项目配置](https://github.com/pyo3/maturin/blob/main/guide/src/config.md)
- 发布 wheel 覆盖 macOS、Windows、Linux glibc 的 x64/ARM64，并提供 Linux musl 的 x64/ARM64 wheel。源码安装在开始构建前检查 Rust 工具链。

### DeepSeek Harness 插件

- 保留一个 npm 包，内置分平台 wheel 集合；manifest 记录版本、平台/ABI 标签、文件名和 SHA-256。
- 按实际托管 Python 的兼容标签选择 wheel，拒绝不匹配或校验失败的文件。缓存身份包含平台和 wheel 摘要。
- 插件使用与 Python 发布流程相同提交构建出的产物；正式 npm 发布要求完整的平台集合，`prepack` 不得覆盖为本机单个平台包。
- 延续现有私有运行环境、安装锁、旧环境保留和离线缓存复用机制；安装失败仍可使用恢复界面。

### 安装器与发布

- 保留一行安装器的公共 URL 和现有路径覆盖变量。普通安装选择已发布版本，安装对应 wheel，并使用同版本 Skill 文档。
- 本地 checkout 和显式源码安装继续走源码构建；开发 bootstrap 明确检查 Rust。
- 已安装模式的 launcher 调用虚拟环境中的包入口，避免源码目录遮蔽已安装的 `_native` 扩展。
- CI 先完成平台 wheel 集合和 sdist 校验，再统一发布。Homebrew 继续从实际 PyPI sdist 生成公式及哈希，并更新构建资源。
- 同步维护 Python 与插件各自的版本、变更日志和发布说明。

## 5. 实施顺序与验收

| 顺序 | 交付内容 | 完成条件 |
|---|---|---|
| 1 | 列表计算、窗口化、缓存和应用级传输状态 | 大列表操作完整，切页后任务仍可见、可取消 |
| 2 | Python 执行接口、取消链路、分块传输及清理 | 第一里程碑可独立发布，资源生命周期完整 |
| 3 | Rust 核心与 Python 适配 | 两种执行器通过同一组行为契约测试 |
| 4 | 原生 wheel、插件、安装器和发布流水线 | 各发行平台安装后实际加载并运行 Rust 扩展 |
| 5 | 完整回归、文档及第二里程碑发布 | 所有必需检查通过，回滚方式验证完成 |

必须覆盖的验收场景：

- **传输**：空文件、100 MiB 边界、超限、非 ASCII 文件名、覆盖冲突、接收失败、发送失败、断线和临时文件清理；验证读取分块上限，不测 RSS 跑分。
- **后台任务**：跨页面、跨标签页继续传输；取消排队与活动任务；会话失效、嵌入视图释放后停止；完成后释放文件和对象 URL。
- **取消隔离**：同主机两个任务取消其中一个，另一个及共享连接继续；覆盖 POSIX 子进程组、Windows Job Object、跳板和 AskPass 子进程。
- **列表**：使用 10,000 台合成主机验证渲染窗口有界、搜索、分组、选择、键盘导航和隐私模式；不设置耗时阈值。
- **行为一致性**：Python/Rust 对正常退出、超时、取消、输出超限和启动失败返回一致结果；取消和原生失败不自动重放写操作。
- **发行安装**：干净环境安装 wheel、构建 sdist、旧版本升级、两套 CLI 名称、前端资源、原生扩展加载，以及插件平台选择、校验失败和缓存复用。
- **项目回归**：执行完整 Python 测试、Rust 测试、前端类型与构建一致性检查、浏览器 smoke/SSH 测试，以及插件集成测试。全部使用隔离状态和可信的本地 SSH 测试拓扑。

第一里程碑提供交互与资源管理改善；第二里程碑完成默认启用 Rust 的统一原生发行。整个升级以可验证的行为完成度作为发布依据。
