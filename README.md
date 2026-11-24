
# # DSH Skill Forge

A DSH plugin that adds a left-sidebar panel for managing installed skills, plus a `make-skill` agent preset and GitHub skill search.

中文：一个 DSH 插件，在左侧栏提供已安装 skill 的管理面板，并附带「制作 skill」预设模式与 GitHub skill 搜索。

## What it does / 功能

- Adds a `sidebar.panellist` entry and a `main` panel listing all installed skills. Sources include project/user skill roots (`.dsh/skills`, `.agents/skills`, `customSkillDirs`, including junction/symlink bundles) and built-in/runtime skills from DSH's own `ctx.skills` registry. Built-in skills are shown as read-only.
- Expands each skill's `SKILL.md` frontmatter and body inline beneath its row; click again to collapse.
- Toggles a skill's visibility to the model by rewriting only the `disable-model-invocation` frontmatter field with a single-line text patch, leaving other YAML fields untouched. Available for file-backed skills only.
- Creates a directory-style skill (`<name>/SKILL.md`) in the user skill root, and deletes skills. All paths are validated against the skill roots.
- Declares an agent preset `make-skill` (`preset-make-skill`) via the bundle patch. The preset sets a skill-author persona and mounts file read/write, file search, skill filesystem, skill loader, todo, ask-user and a compaction group.
- Adds a GitHub repository search: type a keyword to search public repositories, then "adopt" one to open a new session in the `make-skill` preset with the repo context prefilled, or start that session directly from the keyword.

## Install / 安装

In DSH, open **Plugins → Add plugin** and select this directory. After installing, refresh the page; the "Skills" icon appears in the left sidebar.

`package.json` declares a `dsh.bundle` manifest pointing at `cordis.patch.yml`, so the repository is installable with `dsh plugin add`.

## How it is built / 实现说明

- **Host half (`index.js`)**: registers a `webServer` prefix route `/dsh-skill-forge-api` for list / detail / visibility toggle / create / delete / GitHub search. Reads skills from both the filesystem roots and `ctx.skills` (soft lookup). GitHub search prefers DSH's `web` service and falls back to native HTTPS with a relaxed-TLS retry for MITM proxies.
- **Client half (`client.js`)**: registers the sidebar entry, the management panel and the GitHub search modal. Uses only the host React module and `--dsw-alias-*` theme tokens; no DSH Client internal packages are imported.
- **Compatibility**: all service access is soft (`ctx.get`) and wrapped in try/catch; each slot registration is independent; missing services or slots degrade without breaking other plugins.

## Repository layout / 目录结构

```
.
├── index.js            # Host: HTTP API
├── client.js           # Client: sidebar entry, panel, GitHub search
├── cordis.patch.yml    # bundle patch: plugin row + make-skill preset
├── package.json
├── icon.svg
├── locale/
│   ├── en.json
│   └── zh.json
└── docs/
    └── DETAIL.md
```

## Requirements / 依赖

- DeepSeek Harness with `dsh.bundle` plugin support and the Web client.
- Shipped packages used by the preset (`dsh-persona`, `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-skill-filesystem`, `dsh-tool-skill`, `dsh-tool-todo`, `dsh-tool-ask-user`, `dsh-compaction-basic`, `dsh-command-compact`) are distributed with DSH.
- Optional: set `GITHUB_TOKEN` to raise the GitHub API rate limit for search.

## Limitations / 已知限制

- Built-in and runtime skill bodies cannot be read by this panel (no writable file and the registry does not expose a body). The detail view shows a note and suggests loading the skill in a session.
- GitHub search uses the public API; anonymous requests are rate-limited.
- The detail view is read-only. Edit a skill body with a file tool and refresh the panel.

## License

MIT
