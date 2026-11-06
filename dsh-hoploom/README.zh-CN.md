# dsh-hoploom

[English](README.md)

把 [Hoploom](https://github.com/xiayh0107/hoploom) 接入 **DeepSeek Harness**。
自然语言查询 SSH 主机、跳板链路、工作目录和主机技能；在对话旁的右侧栏直接使用完整的 Hoploom 界面。
密码和密钥口令仍由操作系统保险库保存。

## 安装即可开始

需要 **dsh 0.2.1-rc.5 或更新的 0.2.x 版本**（已在 0.2.1-rc.5 和 0.2.2-rc.1 上验证）、
Node.js 22.19+（22.x）或 24+。
**从 0.2.0 开始，无需先安装 Hoploom 或 Python。**

1. 在 **插件 → 添加插件** 中输入包名 `dsh-hoploom`，或运行：

   ```sh
   dsh plugin --profile web add dsh-hoploom
   dsh web
   ```

   终端界面把 `web` 换成 `tui`。
2. 点击侧边栏的 **Hoploom**，或在右侧栏的“开始”页选择它。Hoploom 在右侧栏打开，对话保持可见；
   需要更大空间时使用面板的全屏按钮。插件自动准备内置后端和独立 Python 环境。
   首次需要联网，可能花费几分钟；可以取消或重试。MCP 工具也可复用已有的兼容安装。
3. 准备好后，**原有 Hoploom UI 直接显示在 dsh 内**，包含主机、端口、标签、技能、
   凭据、审计和文件管理。直接添加主机、录入凭据，再问 Agent：“列出我保存的服务器”。

插件运行在 **dsh 后端所在机器**，使用同一系统账号的主机库。
远程访问 dsh 时，仍在当前 dsh 页面内管理后端机器的主机库，无需打开另一个浏览器。
插件无需额外 API Key。远程 SSH 操作仍需要系统 OpenSSH；保存凭据需要可用的系统保险库。

自动准备支持 macOS、Windows、Linux（glibc）的 x64 和 ARM64。运行环境工具 uv
从 Astral 官方 GitHub Release 下载并校验固定 SHA256，Python 由 uv 管理，依赖从
PyPI 安装；Hoploom 后端已包含在 npm 包内。不会修改系统 Python 或 shell 配置。
后续启动复用本地环境，可离线启动。

也可安装 [GitHub Release](https://github.com/xiayh0107/hoploom/releases) 附件：

```sh
dsh plugin --profile web add /绝对路径/dsh-hoploom-0.2.2.tgz
```

更新：`dsh plugin --profile web update dsh-hoploom@latest`。
卸载：`dsh plugin --profile web remove dsh-hoploom`。
通过 CLI 修改 `desktop` 配置前，需完全退出桌面应用；运行时使用应用的插件页面。
从 0.1.x 升级后，需要在当前任务结束后完整重启 dsh 才能显示新增的侧边栏入口。
dsh 0.2.1-rc.5 会把旧插件“没有前端入口”的结果缓存到后端进程退出，仅刷新页面无效。
插件 0.2.0 只接受 dsh 0.2.1-rc.5，更新的 dsh 会拒绝安装并在启动时跳过它；请升级到 0.2.1 或更新版本。

卸载会注销工具并停止插件启动的进程，保留主机库、保险库和托管环境。

## 能力与设置

默认提供六个 `mcp__hoploom__` 工具：

| 工具 | 用途 |
| --- | --- |
| `list_hosts` | 按名称、标签筛选本地主机 |
| `host_route` | 查看 ProxyJump 链路 |
| `saved_paths` | 查询主机工作目录 |
| `host_skills` | 解析主机绑定技能 |
| `list_tunnels` | 查看转发配置和本机状态 |
| `runtime_capabilities` | 查看本机能力与权限 |

另有 `hoploom_setup`，支持 `action=status`、`prepare`、`cancel`。
后端准备失败时仍可使用。终端会话中让 Agent 报告一次进度或按要求重试，无需反复轮询。
安装、启动、打开插件面板和清单查询不会自动连接服务器。

进入 **插件 → dsh-hoploom → 配置**，编辑 `dsh-hoploom` 条目：

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `command` | `hoploom` | 复用现有安装，否则自动准备 |
| `commandArgs` | `[]` | `mcp serve` 前的参数，不经过 shell |
| `autoInstall` | `true` | 需要时自动准备独立运行环境；关闭后可手动点击准备 |
| `managedDir` | 空 | 可选的托管环境绝对路径 |
| `allowRemote` | `false` | 开启 `test_host` 连通性检查 |
| `allowExec` | `false` | 开启 `run_command`，须配置白名单 |
| `allowCommands` | `[]` | 例如 `["uptime", "df -h"]` |
| `dataDir` / `runtimeDir` | 空 | 可选的数据、运行目录绝对路径 |
| `toolCallTimeoutMs` | `660000` | MCP 调用超时，后端超时限制仍生效 |

托管环境默认位于 `$DSH_HOME/plugin-data/hoploom`，未设置 DSH_HOME 时为
`~/.dsh/plugin-data/hoploom`。主机库和保险库沿用 Hoploom 原有位置。

默认命令会搜索 PATH 中的绝对目录、`~/.local/bin`、macOS Homebrew 目录和 Windows
`%LOCALAPPDATA%\hoploom\bin`。显式命令、绝对路径或参数前缀不会被自动替换，必须支持
`mcp serve`；旧 `serverctl 0.7.0` 不支持。Windows 支持 `hoploom.cmd`、`hoploom.exe`，
也可用绝对 Python 路径和 `commandArgs` 指定启动器。不接受相对命令路径。

空白名单不能开启执行；只设置白名单也不会自动开启执行。白名单匹配完整 argv 或可执行文件，
`*` 允许任意命令，允许解释器就允许其接收的程序。远程操作仍需用户任务授权。
被禁用的工具不能通过原始 SSH 或其他 shell 绕过。配置中不要填写密码、令牌或密钥口令。

## 主机管理与排错

打开 **Hoploom** 面板后，插件启动私有回环服务，在 dsh 内嵌入原有前端，不跳转外部浏览器。
界面始终使用随插件发布的后端；即使 MCP 复用了现有 CLI，首次打开界面时也会准备独立运行环境。
两者共用配置的主机库和保险库。卸载仅停止插件自己的进程。

页面请求经过 dsh 的所有者认证，每个界面有独立会话，并保留原有 CSRF 和凭据显示验证。
页面不接收启动令牌。通行密钥需要受支持的 HTTPS 域名或 localhost；桌面应用和 IP 地址页面
显示秘密时使用原有的本地主密码验证。凭据录入直接在内嵌 UI 完成。
独立安装仍可使用 `hoploom ui`，交互式登录使用终端中的 `hoploom connect ALIAS`。
首次主机指纹信任由用户核验。

首次准备失败时，Hoploom 图标和面板仍可使用。检查网络、代理或磁盘空间后点击 **重试**。
自定义命令失败时修正配置，或恢复默认 `hoploom` 启用自动准备。
从 0.1.x 的 `spawn hoploom ENOENT` 升级后，同样可以恢复默认命令解决依赖缺失。
不要再添加另一个名为 `hoploom` 的通用 MCP 连接。

开发与发布见 [English README](README.md#development-and-release) 和
[维护者文档](https://github.com/xiayh0107/hoploom/blob/main/ssh-server-manager/docs/dsh-plugin.md)。
