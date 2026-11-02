# dsh-hoploom

[English](README.md)

把 [Hoploom](https://github.com/xiayh0107/hoploom) 接入 **DeepSeek Harness**。
用自然语言查询已保存的 SSH 主机、跳板链路、工作目录和主机绑定的技能；需要远程操作时，
在插件设置中开启检查或白名单命令。保存的密码和密钥口令仍由操作系统保险库管理。

## 安装

需要 **dsh 0.2.1-rc.5**、Node.js 22.19+（22.x）或 24+，以及本机 Hoploom。
插件在 **dsh 后端所在机器**上运行，即使你通过浏览器使用 dsh，也读取后端机器同一系统账号的主机库。
npm 安装不会自动安装 Python、OpenSSH 或 Hoploom。

1. 已有 Hoploom 就继续使用；新用户运行 Hoploom 的
   [源码安装器](https://github.com/xiayh0107/hoploom#one-line-agent-skill-deployment)。
   在启动 dsh 的终端检查 `hoploom --version` 和 `hoploom mcp tools`。
   源码安装不依赖改名后的 PyPI 包是否已经发布。
2. 在 dsh 的 **插件 → 添加插件** 中搜索 `dsh-hoploom`，或者运行：

   ```sh
   dsh plugin --profile web add dsh-hoploom
   dsh web
   ```

   终端界面把 `web` 换成 `tui`。
3. 直接问：“列出我保存的服务器”“web1 通过哪些跳板连接？”“web1 保存了哪些工作目录？”

也可以下载 [GitHub Release](https://github.com/xiayh0107/hoploom/releases) 中的插件包安装：

```sh
dsh plugin --profile web add /绝对路径/dsh-hoploom-0.1.0.tgz
```

更新：`dsh plugin --profile web update dsh-hoploom@latest`。
卸载：`dsh plugin --profile web remove dsh-hoploom`。
卸载会移除工具并停止桥接进程，不删除 Hoploom 主机库或保险库条目。

## 默认能力

工具统一以 `mcp__hoploom__` 开头，具体参数直接从本机 Hoploom 获取。

| 工具 | 用途 |
| --- | --- |
| `list_hosts` | 按名称、标签筛选本地主机清单 |
| `host_route` | 查看保存的 ProxyJump 链路 |
| `saved_paths` | 查询指定主机保存的工作目录 |
| `host_skills` | 解析指定主机绑定的技能元数据 |
| `list_tunnels` | 查看转发配置和本机运行状态 |
| `runtime_capabilities` | 查看本机能力与当前权限设置 |

安装、启动和清单查询不会自动连接服务器。插件会指导 Agent 先确定用户指定的目标，
再解析该主机的技能。被关闭的远程工具不能通过原始 SSH 或其他 shell 命令绕过。

## 开启远程操作

进入 **插件 → dsh-hoploom → 配置**，编辑 `dsh-hoploom` 条目：

- `allowRemote: true`：增加 `test_host` 连通性检查工具。
- `allowExec: true` 并设置 `allowCommands`：增加 `run_command`。
  例如 `allowCommands: ["uptime", "df -h"]`。
- `command`：默认 `hoploom`；桌面端找不到命令时，填可执行文件的绝对路径。
- `commandArgs`：放在 `mcp serve` 前的参数数组，不经过本地 shell 解析。
- `dataDir` / `runtimeDir`：可选的独立数据目录和运行目录，必须是绝对路径。
- `toolCallTimeoutMs`：默认 660000 毫秒，后端仍执行每条命令自己的超时限制。

空白名单不能开启命令执行；只设置白名单也不会自动开启执行。
白名单沿用 Hoploom 的 glob 规则，可匹配完整 argv 拼接文本或可执行文件。
允许 `sh`、`python` 等解释器就允许它们接收的程序；只有确实需要任意命令时才使用 `*`。
启用工具不等于授权 Agent 对所有主机执行所有操作。

Windows 可使用 pip 安装的 `hoploom.exe`，也可以把 `command` 设置为该安装环境的
Python 路径，把 `commandArgs` 设置为 `["C:\\路径\\ssh-server-manager\\scripts\\hoploom.py"]`。
改名前的旧安装若提供同样的 MCP 接口，可以把 `command` 设置为 `serverctl`；
不要安装 PyPI 上同名但无关的 `serverctl` 包。

## 主机和凭据管理

在本机终端运行 `hoploom ui`，打开 Hoploom 自己的管理界面添加主机或录入凭据。
交互式登录使用 `hoploom connect ALIAS`，首次主机指纹信任由用户核验。
插件不会转发管理页的启动令牌，不提供密码读取工具，不放宽主机密钥校验。
任何插件配置中都不要填密码、令牌或密钥口令。

启动失败时，检查 dsh 后端进程的 PATH 和配置的可执行文件，修复后重新启用插件。
不要同时再添加一个名为 `hoploom` 的通用 MCP 连接。

开发、测试与发布方式见 [English README](README.md#development-and-release) 和
[维护者文档](https://github.com/xiayh0107/hoploom/blob/main/ssh-server-manager/docs/dsh-plugin.md)。
