# dsh-hoploom

[English](README.md)

把 [Hoploom](https://github.com/xiayh0107/hoploom) 接入 **DeepSeek Harness**。
自然语言查询 SSH 主机、跳板链路、工作目录和主机技能；侧边栏查看准备状态、打开主机管理。
密码和密钥口令仍由操作系统保险库保存。

## 安装即可开始

需要 **dsh 0.2.1-rc.5**、Node.js 22.19+（22.x）或 24+。
**从 0.2.0 开始，无需先安装 Hoploom 或 Python。**

1. 在 **插件 → 添加插件** 中搜索 `dsh-hoploom`，或运行：

   ```sh
   dsh plugin --profile web add dsh-hoploom
   dsh web
   ```

   终端界面把 `web` 换成 `tui`。
2. 点击侧边栏的 **Hoploom** 图标。已有可用安装时直接复用；否则自动准备内置 Hoploom
   和独立 Python 环境。首次需要联网，可能花费几分钟；可以取消或重试。
3. 点击 **打开主机管理** 添加主机、录入凭据。然后问 Agent：“列出我保存的服务器”
   或“web1 通过哪些跳板连接，有哪些工作目录？”

插件运行在 **dsh 后端所在机器**，使用同一系统账号的主机库。
远程浏览器访问 dsh 时，主机管理也在后端机器的默认浏览器打开。
插件无需额外 API Key。远程 SSH 操作仍需要系统 OpenSSH；保存凭据需要可用的系统保险库。

自动准备支持 macOS、Windows、Linux（glibc）的 x64 和 ARM64。运行环境工具 uv
从 Astral 官方 GitHub Release 下载并校验固定 SHA256，Python 由 uv 管理，依赖从
PyPI 安装；Hoploom 后端已包含在 npm 包内。不会修改系统 Python 或 shell 配置。
后续启动复用本地环境，可离线启动。

也可安装 [GitHub Release](https://github.com/xiayh0107/hoploom/releases) 附件：

```sh
dsh plugin --profile web add /绝对路径/dsh-hoploom-0.2.0.tgz
```

更新：`dsh plugin --profile web update dsh-hoploom@latest`。
卸载：`dsh plugin --profile web remove dsh-hoploom`。
通过 CLI 修改 `desktop` 配置前，需完全退出桌面应用；运行时使用应用的插件页面。
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
| `autoInstall` | `true` | 缺少默认后端时自动准备；关闭后可手动点击准备 |
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

**打开主机管理** 只在点击后启动本机回环界面；单纯打开插件面板不会启动管理服务。
已有 UI 会复用；卸载仅停止插件自己启动的 UI。启动令牌不会传给插件页面。
独立安装仍可使用 `hoploom ui`，交互式登录使用终端中的 `hoploom connect ALIAS`。
首次主机指纹信任由用户核验。

首次准备失败时，Hoploom 图标和面板仍可使用。检查网络、代理或磁盘空间后点击 **重试**。
自定义命令失败时修正配置，或恢复默认 `hoploom` 启用自动准备。
从 0.1.x 的 `spawn hoploom ENOENT` 升级后，同样可以恢复默认命令解决依赖缺失。
不要再添加另一个名为 `hoploom` 的通用 MCP 连接。

开发与发布见 [English README](README.md#development-and-release) 和
[维护者文档](https://github.com/xiayh0107/hoploom/blob/main/ssh-server-manager/docs/dsh-plugin.md)。
