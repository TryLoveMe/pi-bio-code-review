# Bio Code Review：Pi 生信代码审查 extension（第一版）

这个 extension 用于让 Pi **先提交精简分析方案，得到用户批准后只写代码，由用户亲自运行**。

它不是独立软件，也不是单纯提示词。它通过 Pi extension API：

- 在每轮对话前注入当前阶段的约束；
- 拦截工具调用；
- 保存方案、批准和检查状态；
- 在底部显示当前状态；
- 从实际脚本生成“每一步用了哪些代码”的对照文档。

## 第一版实现的流程

### 1. 开始方案阶段

```text
/bio-start
```

也可以指定独立交付目录：

```text
/bio-start 我的分析交付
```

执行命令后会自动触发下一轮对话，AI 会立即开始确认信息或提交方案。

此阶段：

- AI 可以阅读你允许它读取的资料并向你提问；
- AI 必须提交最短可行方案；
- AI 不能写文件；
- AI 不能运行 Bash、R、Python、Eval、Notebook 或子代理分析。

方案中的每一步必须说明：

1. 必要、条件触发还是可选；
2. 做什么；
3. 为什么做；
4. 不做会影响哪个判断；
5. 对应哪个实际代码文件；
6. 会产生什么输出。

### 2. 批准方案

方案提交后，可以直接输入以下任一句：

```text
同意
批准
approve
```

也可以运行：

```text
/bio-approve
```

如果 AI 尚未正式提交方案，extension 会自动要求 AI 立即提交，而不是无反应。方案仍有待确认项时，会明确警告，并由你决定是否继续。批准后会自动触发下一轮对话并开始生成代码。批准后：

- AI 只能在独立交付目录内写代码；
- 原始数据和工作区其他文件保持只读；
- AI 仍不能执行分析；
- AI 不能擅自增加步骤、筛选、样本删除或统计方法。

### 3. 检查代码对应关系

代码写完后，由用户运行：

```text
/bio-check
```

这个命令**不会运行分析**。它会：

- 检查方案声明的脚本是否全部存在；
- 检查脚本是否为空；
- 直接读取实际脚本；
- 按分析步骤生成 `代码步骤对照.md`；
- 给代码加显示行号，方便逐行审查；
- 检查通过后锁定代码，防止继续悄悄修改。

注意：文件存在且能读取，只证明方案和脚本已建立对应关系，**不证明统计设计或代码结果一定正确**。

### 4. 查看或重置状态

```text
/bio-status
/bio-reset
```

`/bio-reset` 只清空流程状态，不删除任何文件。

## 安装

**只安装一次。** 全局安装和项目内安装只能选一个。

同时装两份会加载两个互相独立的实例：你批准了其中一份，另一份仍停在方案阶段，会继续拦住所有写文件操作，让流程卡死。当前版本已加入防重复保护（第二份实例自动停用），但正确的做法仍然是只装一份。

### 安装为全局 extension（推荐）

装一次，所有项目都能用：

```bash
mkdir -p ~/.pi/agent/extensions/bio-code-review
curl -L https://raw.githubusercontent.com/TryLoveMe/pi-bio-code-review/main/extension/index.ts \
  -o ~/.pi/agent/extensions/bio-code-review/index.ts
```

### 安装到单个项目

只在这个项目里生效，需要 Pi 信任该项目后才会加载：

```bash
mkdir -p .pi/extensions/bio-code-review
curl -L https://raw.githubusercontent.com/TryLoveMe/pi-bio-code-review/main/extension/index.ts \
  -o .pi/extensions/bio-code-review/index.ts
```

只应安装你已阅读并信任的 extension。Pi extension 与本机进程拥有相同权限。

## 加载方法

本仓库的扩展源码位于 `extension/index.ts`，不在自动加载目录内，所以克隆仓库本身不会自动启用它。

安装后运行：
```text
/reload
```

也可以临时测试：

```bash
pi -e ./.pi/extensions/bio-code-review/index.ts
```

还可以在启动时直接进入方案阶段：

```bash
pi --bio-code-only
```

## 安全边界

第一版会直接拦截常见执行入口，包括：

- `bash`、`powershell`、`eval`；
- `ctx_execute`、`ctx_execute_file`、`ctx_batch_execute`；
- MCP 调用；
- 子代理；
- 名称中明显包含 shell、terminal、exec、python、rscript、notebook 的工具。

它不拦截用户自己输入的 `!` / `!!` 命令，因为“由用户亲自运行”是这个流程的目的。

第三方 extension 可以注册任意名称的新工具。若某个第三方工具使用不明显的名称却在内部执行程序，第一版无法仅凭名称识别。正式长期使用前，应根据你实际启用的工具清单补充禁止名单，或者在专用 Pi 配置中只启用只读和写文件工具。

## 开发与测试

流程测试用假的 Pi API 装载扩展，按真实使用顺序跑一遗：方案阶段 → 批准 → 只写代码 → 检查锁定 → 会话恢复，共 42 项断言。

```bash
bun tests/flow.test.mjs
```

测试需要能解析 `@earendil-works/pi-ai`、`@earendil-works/pi-tui`、`typebox`。装有 Pi 的机器上可以直接链到全局包：

```bash
mkdir -p node_modules/@earendil-works
ln -sfn "$(dirname "$(command -v pi)")/../lib/node_modules/@earendil-works/pi-coding-agent" node_modules/@earendil-works/pi-coding-agent
# 再把 pi-coding-agent/node_modules 下的 pi-ai、pi-tui、typebox 链到 node_modules
```

## 第一版暂未实现

- 不判断生物学结论是否正确；
- 不自动解析用户运行后的所有结果；
- 不自动安装 R/Python 包；
- 不提供复杂图形界面；
- 不允许在已锁定方案上直接改代码。需要改变分析方法时，应重新 `/bio-start`，重新提交并批准方案。
