# DSH Skill Forge

A DeepSeek Harness (DSH) plugin that adds a left-sidebar panel for managing installed skills, a `make-skill` agent preset for authoring new skills, and GitHub skill search with model-assisted prompt enhancement.

中文：一个 DSH 插件，在左侧栏提供已安装 skill 的管理面板，附带「制作 skill」预设模式，以及带模型提示词增强的 GitHub skill 搜索。

## Why / 背景

Skills in DSH accumulate from several places: project roots, user roots, agent config roots, custom directories, and DSH's own bundled skills. Answering "what skills are installed", "what does this one do", or "hide this one from the model for now" otherwise means opening `SKILL.md` files by hand. Writing a new skill also has a recurring shape — directory layout, frontmatter fields, how to phrase `description` so the model routes correctly. This plugin puts the management side in one panel and packages the authoring side into a preset.

## Features / 功能

### 1. Skill inventory panel

Adds a `sidebar.panellist` entry and a `main` panel. The panel lists every installed skill in a table with: name, description, source, model-visibility status, and an actions column.

Skill sources:

| Source | Path | Managed |
|---|---|---|
| Project DSH | `<cwd>/.dsh/skills` | yes |
| Project agents | `<cwd>/.agents/skills` | yes |
| Custom | directories in `customSkillDirs` | yes |
| User DSH | `~/.dsh/skills` | yes |
| User agents | `~/.agents/skills` | yes |
| Bundled / runtime | DSH's `ctx.skills` registry | read-only |

Junctions and symlinks are followed, so linked skill bundles are discovered. Bundled and runtime skills are marked "Built-in · read-only".

### 2. Inline detail

Clicking the document icon on a row expands that row's `SKILL.md` frontmatter and body directly beneath it; clicking again collapses it. Only one row is expanded at a time. Detail content is cached per skill, so reopening does not re-fetch.

The detail view is read-only. Edit a skill body with a file tool and refresh the panel.

### 3. Model visibility toggle

For file-backed skills, the eye icon toggles visibility to the model. It rewrites only the `disable-model-invocation` frontmatter field with a single-line text patch; other YAML fields (lists, block scalars, comments) are left byte-for-byte intact. A toast confirms each change (`Now visible to the model` / `Now hidden from the model`). Built-in skills have no writable file, so the button is not shown.

### 4. Create and delete

The "New skill" form takes a topic keyword and opens a `make-skill` preset session (see prompt enhancement below); the agent creates the directory-style skill `<name>/SKILL.md` from there. Delete removes the skill directory or flat `.md` file. Every path is validated to stay inside a skill root.

### 5. `make-skill` agent preset

The bundle patch declares a preset (`preset-make-skill`, order 5, id `make-skill`). It sets a skill-author persona and mounts: `dsh-persona`, `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-skill-filesystem`, `dsh-tool-skill`, `dsh-tool-todo`, `dsh-tool-ask-user`, and a compaction group (`dsh-compaction-basic`, `dsh-command-compact`). It can be selected from the new-session preset picker like any other preset.

### 6. GitHub search and prompt enhancement

The "Find on GitHub" button opens a modal:

- Search public repositories by keyword (GitHub REST API, sorted by stars, up to 12 results). Each result shows name, description, stars and language, with a link to the repository.
- "Use this" adopts a repository and opens a `make-skill` session with the repo context prefilled.
- The same keyword can start a session directly without searching.

Before the session opens, the plugin tries to enhance the draft prompt with an available configured model through `ctx.llm`:

- It lists live providers, prefers first-party routes, then tries every provider and model in round-robin order. Third-party model plugins (for example `ourfreemodel`, `dsh-connect-workbuddy`) are ordinary providers and are tried too.
- The first provider that returns usable text wins. A provider that fails with insufficient balance, auth error, timeout, or a stream error is skipped and the next one is tried.
- There is a 20-second per-call timeout and a 45-second total budget.
- If no model works, the original prompt is kept silently and the session still opens.

## HTTP API / 接口

The Host half registers a `webServer` prefix route `/dsh-skill-forge-api`. All operations are JSON.

| Op | Method | Purpose |
|---|---|---|
| `list` | POST | List all skills and roots |
| detail | GET `?name=&source=` | Read one skill's body and frontmatter |
| `enhancePrompt` | POST | Enhance a draft prompt via `ctx.llm`; returns `ok:false` with the original prompt on failure |
| `searchGithub` | POST | Search GitHub repositories |
| `setEnabled` | POST | Toggle `disable-model-invocation` |
| `create` | POST | Create a directory-style skill |
| `delete` | POST | Delete a skill |

GitHub search uses native HTTPS first (with a relaxed-TLS retry for MITM proxies) and DSH's `web` service as fallback, with one retry on transient non-JSON responses.

## Install / 安装

In DSH, open **Plugins → Add plugin** and select this directory. Refresh the page; the "Skills" icon appears in the left sidebar.

`package.json` declares a `dsh.bundle` manifest pointing at `cordis.patch.yml`, so the repository is also installable with `dsh plugin add`.

## Configuration / 配置

No required configuration. Optional:

| Input | Purpose |
|---|---|
| `GITHUB_TOKEN` environment variable | Raises the GitHub search rate limit |
| `customSkillDirs` (DSH skill config) | Adds extra skill roots that the panel will scan and manage |

## How it is built / 实现说明

- **Host half (`index.js`)**: registers the HTTP API. Reads skills from filesystem roots and `ctx.skills` (soft lookup). Calls `ctx.llm` for prompt enhancement.
- **Client half (`client.js`)**: registers the sidebar entry, panel and GitHub modal. Uses only the host React module and `--dsw-alias-*` theme tokens; no DSH Client internal packages are imported.
- **Compatibility**: service access is soft (`ctx.get`) and wrapped in try/catch; each slot registration is independent; missing services or slots degrade without breaking other plugins. Hover feedback is deliberately subtle so text stays legible in dark themes.

## Repository layout / 目录结构

```
.
├── index.js            # Host: HTTP API and LLM enhancement
├── client.js           # Client: sidebar entry, panel, GitHub search, preset jump
├── cordis.patch.yml    # bundle patch: plugin row + make-skill preset
├── package.json
├── icon.svg
├── locale/
│   ├── en.json
│   └── zh.json
├── docs/
│   └── DETAIL.md       # Plugin detail page copy
└── SUBMIT.yml          # Entry template for awesome-dsh-plugin
```

## Requirements / 依赖

- DeepSeek Harness with `dsh.bundle` plugin support and the Web client.
- Packages used by the preset (`dsh-persona`, `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-skill-filesystem`, `dsh-tool-skill`, `dsh-tool-todo`, `dsh-tool-ask-user`, `dsh-compaction-basic`, `dsh-command-compact`) are distributed with DSH.
- Prompt enhancement requires at least one configured LLM provider; without one the original prompt is used.

## Troubleshooting / 常见问题

- **No "Skills" icon after install** — refresh the page; check that the plugin row is enabled in Plugins.
- **"Built-in · read-only" skills cannot be edited** — their files are inside DSH's installation, not a writable skill root. Load them in a session instead.
- **Detail shows a note instead of a body** — bundled/runtime skills do not expose a body through the registry; use `/skill-name` or the skill tool in a session.
- **GitHub search fails** — anonymous GitHub API requests are rate-limited; set `GITHUB_TOKEN`. Some networks require the relaxed-TLS fallback already built in.
- **Prompt enhancement did not change the text** — no provider succeeded (no model configured, insufficient balance, or all calls failed). The original prompt is used by design.

## License

MIT
