# DSH Skill Forge

一个给 DeepSeek Harness（DSH）用的插件：在左侧栏提供已安装 skill 的管理面板，附带「制作 skill」预设模式，以及带模型提示词增强的 GitHub skill 搜索。

## 为什么做这个

DSH 里的 skill 来源很分散：项目目录、用户目录、agents 配置目录、自定义目录，还有 DSH 自己内置的一批。想知道「我到底装了哪些 skill」「这个 skill 是干嘛的」「怎么临时把某个 skill 对模型隐藏一下」，以前得一个个手动打开 `SKILL.md` 翻。写一个新 skill 也有固定套路——目录结构、frontmatter 要填什么、`description` 怎么写模型才会正确路由。这个插件把管理那部分集中到一个面板，把创作那部分打包成一个预设。

## 功能

### 1. skill 列表面板

在左侧栏注册一个入口，打开一个主面板，用表格列出所有已安装的 skill：名称、描述、来源、对模型的可见状态，以及操作按钮。顶部有筛选框，可按名称、描述或来源实时过滤；旁边显示总数 / 可见 / 隐藏三个计数。

skill 来源：

| 来源 | 路径 | 可管理 |
|---|---|---|
| 项目 DSH | `<cwd>/.dsh/skills` | 是 |
| 项目 agents | `<cwd>/.agents/skills` | 是 |
| 自定义 | `customSkillDirs` 里配的目录 | 是 |
| 用户 DSH | `~/.dsh/skills` | 是 |
| 用户 agents | `~/.agents/skills` | 是 |
| 内置 / 运行时 | DSH 的 `ctx.skills` 注册表 | 只读 |

目录联接（junction）和符号链接都会跟随，链接过来的 skill 也能被发现。内置和运行时 skill 标记为「内置 · 只读」。

### 2. 行内详情

点某一行的文档图标，会在该行正下方展开它的 `SKILL.md` frontmatter 和正文；再点一次收起。同一时间只展开一行。详情按 skill 缓存，重复展开不会重新请求。

详情是**只读预览**。要改正文用文件工具编辑 `SKILL.md`，刷新面板即可反映改动。详情页里还有「复制路径」按钮，可把该 skill 的 `SKILL.md` 绝对路径复制到剪贴板。

### 3. 对模型显示/隐藏

对文件型 skill，眼睛图标切换它对模型的可见性。做法是**只改** frontmatter 里的 `disable-model-invocation` 字段，用单行文本替换，其它 YAML 字段（列表、块标量、注释）保持原样不动。每次切换会弹出提示（「已设为对模型可见」/「已设为对模型隐藏」）。内置 skill 没有可写文件，不显示这个按钮。

### 4. 新建与删除

「新建技能」表单接收一个主题关键词，然后打开「制作 skill」预设会话（见下面的提示词增强），由 AI 在其中创建目录式 skill `<name>/SKILL.md`。删除会移除对应目录或单个 `.md` 文件。所有路径都经过校验，确保不会越出 skill 根目录。

### 5. 「制作 skill」预设模式

bundle patch 声明一个 agent 预设（`preset-make-skill`，order 5，id `make-skill`）。它设置「skill 创作者」人设，并挂载：`dsh-persona`、`dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-skill-filesystem`、`dsh-tool-skill`、`dsh-tool-todo`、`dsh-tool-ask-user`，以及一个压缩组（`dsh-compaction-basic`、`dsh-command-compact`）。它像其它预设一样，可以在新建会话时从预设列表里选。

### 6. 全局 skill 使用引导（所有预设）

插件通过 `ctx.systemPrompt.section()` 注册一条**全局**系统提示词引导，对**所有预设模式**（standard / ptc / minimal / cordis 以及自定义预设）都生效，而不仅限于「制作 skill」预设。内容是：

- 会话中若出现 skill 目录，先阅读它再动手。
- 当用户请求与某个 skill 匹配时，先用 `skill` 工具加载它再开始工作，不凭一行摘要猜内容。
- 多个 skill 相关时一次性全部加载；没有匹配的就照常处理。
- 只有真正加载过的 skill 才能说用过。

这样 AI 会根据用户提示词自动理解并使用相关 skill。这条引导通过宿主注册表实现，不修改、不覆盖任何官方预设；可用配置项 `enableGlobalSkillGuidance: false` 关闭。

### 7. 在对话里 @ 指定 skill

插件向 DSH 的输入框注册一个 `@` 候选项源。在任意会话里输入 `@`，候选里会出现一个 **「技能」大类**；按 Tab 或点击它右侧的箭头进入，菜单会在原位展开全部对模型可见的 skill，顶部显示面包屑，可直接按名称或描述筛选。选中某个 skill 后，输入框会插入 `/skillName `，由 DSH 原生的 `dsh-tool-skill` 在发送时把该 skill 的正文注入上下文——因此真正加载的是完整 skill 内容，而不仅是一行描述。

不想先进入大类也可以：直接接着输入名字（如 `@pdf`）会像普通补全一样就地匹配。这个列表带 60 秒本地缓存，频繁输入不会反复请求。

### 8. 在「+」菜单里选 skill

输入框旁的 **「+」** 菜单里会多出一项「选择一个技能」。选中它后弹出二级选择器（支持模糊搜索），挑中某个 skill 就会把 `/skillName ` 插入当前草稿；如果草稿里已有内容，会追加在后面而不是覆盖。这样「+」和 `@` 两条路径都能选 skill，区别是 `@` 直接插入、`+` 走一个带搜索的弹出面板。

### 9. GitHub 搜索与提示词增强

点「从 GitHub 搜索」会打开弹窗：

- 按关键词搜索公开仓库（GitHub REST API，按星标排序，最多 12 条）。每条显示名称、描述、星标和语言。搜索结果会缓存 5 分钟，减少匿名 API 的速率限制。
- 每条右侧有三个按钮：**在 GitHub 打开**（外链图标，在系统浏览器或右侧栏里打开仓库原网页）、**直接安装**、**采用**。
- 点「直接安装」会把仓库里的 `SKILL.md` 下载到你可写的 DSH 技能目录（默认 `~/.dsh/skills`），无需打开浏览器或新建会话；仓库里的多个 skill 会一次性装好，同名的自动跳过。
- 点「采用」则打开「制作 skill」预设会话，并把该仓库信息作为调研上下文预填进输入框，由 AI 帮你改写。
- 不搜索也可以直接用同一个关键词新建会话。

跳转之前，插件会尝试用已配置的模型通过 `ctx.llm` 增强草稿提示词：

- 列出所有在线 provider，优先尝试官方路由，然后按轮询顺序尝试**每一个** provider 和模型。第三方模型插件（如 `ourfreemodel`、`dsh-connect-workbuddy`）也是普通 provider，同样会被尝试。
- 第一个返回可用文本的 provider 胜出。某个 provider 因余额不足、鉴权失败、超时或流错误失败时，会自动跳过、尝试下一个。
- 单次调用超时 20 秒，总预算 45 秒。
- 如果所有模型都不可用，则静默保留原提示词，会话照常打开。

## HTTP 接口

Host 半边注册一个 `webServer` 前缀路由 `/dsh-skill-forge-api`，全部为 JSON。

该路由已接入 DSH 宿主的**准入检查**：每个请求在处理前都会经过 `connection.requestRejection(request)`（宿主/Origin 校验 + 已认证 Peer 校验），未认证的请求会被回以 401/403，和 DSH 自带路由使用同一套策略。面板在浏览器中发出的同源请求会自动携带已签名的浏览器 Cookie，因此正常通过，不受影响。

| 操作 | 方法 | 用途 |
|---|---|---|
| `list` | POST | 列出所有 skill 和根目录 |
| `mention` | POST | 供 `@` 候选项源与「+」菜单使用的轻量 skill 目录（只含可见 skill 的 name/description） |
| 详情 | GET `?name=&source=` | 读取某个 skill 的正文和 frontmatter |
| `enhancePrompt` | POST | 用 `ctx.llm` 增强草稿提示词；失败时返回 `ok:false` 并带回原提示词 |
| `searchGithub` | POST | 搜索 GitHub 仓库（带 5 分钟缓存） |
| `installFromGithub` | POST | 把仓库里的 `SKILL.md` 直接安装到可写 skill 根目录 |
| `setEnabled` | POST | 切换 `disable-model-invocation` |
| `create` | POST | 创建目录式 skill |
| `delete` | POST | 删除 skill |

GitHub 搜索优先用原生 HTTPS（针对 MITM 代理做了宽松 TLS 回退），以 DSH 的 `web` 服务作为后备，并对偶发的非 JSON 响应重试一次。

## 安装

### 方式一：从 GitHub 仓库安装（推荐）

本仓库的 `package.json` 声明了 `dsh.bundle` manifest（指向 `cordis.patch.yml`），可以直接从仓库地址安装：

1. 在 DSH 里打开 **插件（Plugins）** 面板。
2. 点 **添加插件 / Add plugin**，选择「从 GitHub 安装」并填入仓库地址：
   ```
   https://github.com/lwh-chinese/DSH-SKILL-FORGE
   ```
3. 等待安装完成，在插件列表里确认 `dsh-skill-forge` 这一行处于**启用**状态。
4. **刷新 DSH 页面**（这一步很重要：左侧栏入口属于 Web 客户端，不刷新不会出现）。
5. 左侧栏出现「技能」图标即安装成功。

### 方式二：从本地目录安装（开发 / 离线）

如果你已经把源码克隆或下载到本地：

1. 打开 **插件 → 添加插件**，选择「添加本地目录」。
2. 选中包含 `package.json` 的插件根目录（例如 `E:\DSH\dsh-skill-forge`）。
3. 安装完成后同样**刷新页面**。

### 验证安装

- 左侧栏出现「技能」图标，点击能打开管理面板并列出 skill。
- 在「新建会话」的预设列表中能看到「制作 skill」预设。
- 若插件行显示未激活或报错，先看 **插件** 面板里的诊断信息，通常是 DSH 版本不支持 `dsh.bundle` 或缺少 Web 客户端。

### 卸载

在 **插件** 面板里禁用或移除 `dsh-skill-forge` 对应条目，刷新页面后左侧栏入口消失。

### 前提

- DSH 版本需支持 `dsh.bundle` 插件和 Web 客户端（0.2.x 及以上）。
- 无需额外依赖：预设用到的官方包随 DSH 一起分发。

## 配置

没有必填配置。可选项：

| 输入 | 用途 |
|---|---|
| `GITHUB_TOKEN` 环境变量 | 提高 GitHub 搜索和直接安装的速率限制，并能安装私有仓库 |
| `customSkillDirs`（DSH 的 skill 配置） | 增加额外 skill 根目录，面板会扫描并管理它们 |
| `enableGlobalSkillGuidance: false`（插件 config） | 关闭对所有预设生效的全局 skill 使用引导 |

## 实现说明

- **Host 半边（`index.js`）**：注册 HTTP 接口，从文件系统根目录和 `ctx.skills`（软获取）读取 skill，调用 `ctx.llm` 做提示词增强。
- **Client 半边（`client.js`）**：注册侧栏入口、面板、GitHub 弹窗，`@` skill 候选项源（官方 `inputTriggers.registerSource`），以及「+」菜单里的 `/skills` 命令贡献（官方 `commandUi.register`，走 `ctx.inject` 等依赖就绪）。只用宿主的 React 模块和 `--dsw-alias-*` 主题变量，不引入任何 DSH Client 内部包。
- **兼容性**：服务访问一律用软获取（`ctx.get`）并包 try/catch；每个槽位独立注册；缺少服务或槽位时降级，不影响其它插件。悬停反馈刻意做得很轻，保证深色主题下文字清晰。

## 目录结构

```
.
├── index.js            # Host：HTTP 接口与 LLM 提示词增强
├── client.js           # Client：侧栏入口、面板、GitHub 搜索、预设跳转
├── cordis.patch.yml    # bundle patch：插件行 + make-skill 预设
├── package.json
├── icon.svg
├── locale/
│   ├── en.json
│   └── zh.json
├── docs/
│   └── DETAIL.md       # 插件详情页文案
└── SUBMIT.yml          # awesome-dsh-plugin 投稿模板
```

## 依赖

- 支持 `dsh.bundle` 插件的 DeepSeek Harness，以及 Web 客户端。
- 预设用到的包（`dsh-persona`、`dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-skill-filesystem`、`dsh-tool-skill`、`dsh-tool-todo`、`dsh-tool-ask-user`、`dsh-compaction-basic`、`dsh-command-compact`）随 DSH 一起分发。
- 提示词增强需要至少一个已配置的 LLM provider；没有则用原提示词。

## 常见问题

- **装完没有「技能」图标** —— 刷新页面；在插件列表里确认该插件行已启用。
- **内置 skill 标着「只读」不能改** —— 它们的文件在 DSH 安装目录里，不在可写 skill 根目录。在会话里加载使用即可。
- **详情只显示一段说明而不是正文** —— 内置/运行时 skill 不通过注册表暴露正文，在会话里用 `/技能名` 或 skill 工具加载。
- **GitHub 搜索失败** —— 匿名请求的速率有限，设置 `GITHUB_TOKEN`；某些网络需要内置的宽松 TLS 回退。
- **直接安装失败** —— 确认仓库里确实有 `SKILL.md`（根目录或 `skills/<名字>/SKILL.md`），默认分支是否正确；同名 skill 会被跳过以免覆盖。
- **提示词没有被增强** —— 所有 provider 都失败了（没配模型、余额不足或调用出错）。按设计此时使用原提示词。

## 许可证

MIT
