# 技能管理器 / Skill manager

在 DSH 左侧栏新增「技能」入口，打开一个管理面板，用于维护已安装的 skill。

功能：

- 列出所有已安装的 skill，来源覆盖磁盘根目录（项目 `.dsh/skills`、`.agents/skills`，用户 DSH/agents `skills`，自定义目录，含目录联接/符号链接）以及 DSH 内置的 bundled/运行时 skill，显示名称、描述、来源与启用状态。
- 查看某个 skill 的 `SKILL.md` 正文与 frontmatter。
- 通过切换 frontmatter 中 DSH 原生的 `disable-model-invocation` 字段控制 skill 对模型的可见性（不影响原始指令正文，且不会破坏其它复杂 YAML 字段）。
- 在用户技能根目录新建 skill（目录式 `<name>/SKILL.md`），或删除已有 skill。
- 安装时声明 **「制作 skill」预设模式**（`preset-make-skill`）：新建会话可选，以「skill 创作者」人设启动，挂载文件读写、文件搜索、skill 文件系统与 skill 加载工具，专门用于创建、编辑和维护 skill。
- GitHub 搜索新建：点顶部「从 GitHub 搜索」，按关键词搜索公开仓库，点「采用」即跳转到「制作 skill」预设模式的新会话，并把仓库信息作为调研上下文预填；也可直接用关键词进入制作模式。
- 提示词增强：跳转前会尝试用本机已配置的模型（`ctx.llm` 第一个可用 provider/model）把草稿指令改写得更具体；若没有可用模型、余额不足、超时或报错，则保留原提示词并照常跳转。

兼容性：

- 所有服务访问使用软获取与 try/catch，缺少某个槽位或服务时优雅降级，不影响其他插件。
- 使用宿主主题变量与 React 模块表，不打包任何 DSH Client 内部包。
- 管理 API 由本插件自己的 `webServer` 前缀路由提供，不依赖 Typert 代码生成或跨包 Remote。

限制：在面板中以只读方式预览 skill 正文；编辑正文请使用你熟悉的文件工具直接修改 `SKILL.md`，面板会自动反映改动。
