/**
 * dsh-skill-forge — Client half.
 *
 * Registers a left-sidebar entry (sidebar.panellist) that opens a management
 * panel in the central `main` slot. All data goes through this bundle's HTTP
 * API (`/dsh-skill-forge-api`).
 *
 * High-compatibility rules used here:
 *  - All service access is soft (`ctx.get`), wrapped in try/catch.
 *  - Every slot registration is independent; one failing slot cannot stop others.
 *  - Styles use host theme tokens (`--dsw-alias-*`) with fallbacks.
 *  - No Harness Client packages are imported; only React from the module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-forge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'skill-forge'
    const ENTRY_NS = 'skillManager.entry'
    const PAGE_NS = 'skillManager.page'
    // Client context captured at apply(); used by the page to launch the
    // "制作 skill" preset session via ctx.uiWorkspace.startSession.
    let clientCtx = null

    // Bundled prompt template for "新建技能 → 新建对话". {kw} is replaced with
    // the user's keyword. Kept in the plugin so it ships with the bundle.
    const SKILL_PROMPT_TEMPLATE = [
      '请帮我制作一个关于「{kw}」的 DSH skill。',
      '',
      '动手前请先充分利用 skill：',
      '1. 用 `skill` 工具加载 `dsh-doc`，查阅 skill / preset / 插件的权威规范，不要凭记忆猜；',
      '2. 从会话的 skill catalog 里加载最相关的一到两个已有 skill 作为写法参考。',
      '',
      '调研完成后再按 DSH skill 规范创建：',
      '1. 目录式技能 <name>/SKILL.md，name 用 kebab-case；',
      '2. frontmatter 必须包含 name 与 description，description 写清触发场景，可选 whenToUse；',
      '3. 正文是给模型看的可执行指令，步骤清晰、可验证，避免无关内容；需要时再引入 references/、scripts/、assets/ 资源；',
      '4. 保持指令中立、可复用，不硬编码一次性路径。',
      '完成后说明新建 skill 的名称、位置、触发场景，以及你加载了哪些 skill 作为参考。',
    ].join('\n')

    // --- app base prefix (reverse-proxy / subpath compatible) ---
    const detectAppBase = (doc, href) => {
      const strip = p => String(p || '').replace(/\/+$/, '')
      const fromPath = p => {
        const m = /^(.*?)\/plugins\//.exec(String(p || ''))
        return m ? strip(m[1]) : null
      }
      if (!doc) return ''
      try {
        const src = doc.currentScript && doc.currentScript.src
        if (src) {
          const base = fromPath(new URL(src, doc.baseURI || href).pathname)
          if (base !== null) return base
        }
      } catch (e) { /* ignore */ }
      try {
        for (const el of doc.querySelectorAll('script[src]')) {
          const base = fromPath(new URL(el.src, doc.baseURI || href).pathname)
          if (base !== null) return base
        }
      } catch (e) { /* ignore */ }
      return ''
    }
    const APP_BASE = detectAppBase(
      typeof document === 'undefined' ? null : document,
      typeof location === 'undefined' ? '' : location.href,
    )
    const absAppPath = u => {
      const s = String(u == null ? '' : u)
      if (!s || s[0] !== '/' || s[1] === '/') return s
      if (!APP_BASE || s === APP_BASE || s.indexOf(APP_BASE + '/') === 0) return s
      return APP_BASE + s
    }
    const API = absAppPath('/dsh-skill-forge-api')

    async function api(op, extra) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ op }, extra || {})),
      })
      const data = await res.json()
      if (!data || data.ok !== true) throw new Error((data && data.error) || ('HTTP ' + res.status))
      return data
    }

    // The "@" source presents installed skills as ONE drillable category row
    // ("技能") that descends into the skill list — the same two-step shape the
    // built-in @reference source uses for folders. Typing a name directly still
    // type-ahead matches, so `@pdf` keeps working without drilling first.
    //
    // The drill inserts `@技能/` into the draft (the token is replaced by the
    // returned text, trigger char included, exactly like @reference's
    // `@folder/`), which makes the query `技能/` — the descent marker.
    const SKILL_GROUP = '技能'
    const SKILL_GROUP_TOKEN = '@' + SKILL_GROUP + '/'

    function skillGroupQuery(query) {
      const q = String(query || '')
      return q.trim().startsWith(SKILL_GROUP) ? q.trim().slice(SKILL_GROUP.length).replace(/^\//, '') : null
    }

    // Register an "@" trigger source that lists installed skills. Picking one
    // inserts `/skillName `, which DSH's built-in dsh-tool-skill pre-step turns
    // into the skill body — so we reuse the native skill-loading path.
    function registerSkillMentionSource(ctx) {
      let inputTriggers
      try { inputTriggers = (ctx && ctx.inputTriggers) || (ctx && typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined) } catch (e) { return }
      if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') return
      // Short-lived cache: the full catalog rarely changes while typing, so
      // filter locally instead of hitting the API on every keystroke.
      let catalog = null
      let catalogAt = 0
      const loadCatalog = async () => {
        const now = Date.now()
        if (!catalog || now - catalogAt > 60 * 1000) {
          const data = await api('mention', { query: '' })
          catalog = data.items || []
          catalogAt = now
        }
        return catalog
      }
      const asRow = (s, extra) => Object.assign({
        name: s.name,
        label: s.name,
        description: s.description,
        value: s.name,
      }, extra || {})
      const source = {
        trigger: '@',
        name: 'skill-forge', // unique among @ sources; the built-in one is 'reference'
        order: 5,
        // No group title: the menu would render the raw source name ('skill-forge')
        // because unknown source names are echoed verbatim. The single "技能" row
        // already names itself.
        showGroupTitle: false,
        async candidates(session, req) {
          try {
            const list = await loadCatalog()
            const sub = skillGroupQuery(req && req.query)
            if (sub === null) {
              // Top level: one big category. A non-empty query that is not the
              // category token keeps plain type-ahead so `@pdf` still matches.
              const q = String(req && req.query || '').trim().toLowerCase()
              if (q === '') {
                return [{
                  name: SKILL_GROUP,
                  label: SKILL_GROUP,
                  description: (dict().browseSkills || 'Browse installed skills') + ' · ' + list.length,
                  value: SKILL_GROUP,
                  drill: true,
                }]
              }
              return list
                .filter(s => [s.name, s.description].some(v => String(v || '').toLowerCase().includes(q)))
                .map(s => asRow(s))
            }
            // Drilled: the skill list, filtered by whatever follows the token.
            const needle = sub.toLowerCase()
            return list
              .filter(s => !needle || [s.name, s.description].some(v => String(v || '').toLowerCase().includes(needle)))
              .map(s => asRow(s))
          } catch (e) {
            return []
          }
        },
        header(session, req) {
          // Breadcrumb only after the descent, mirroring @reference's folders.
          // Include the token case: a re-track after Enter arrives with
          // drilled=false but query `技能/`, and the crumb should already show.
          if (req && (req.drilled === true || skillGroupQuery(req.query) !== null)) {
            return [{ label: SKILL_GROUP, value: SKILL_GROUP, current: true }]
          }
          return undefined
        },
        onPick(pick) {
          const candidate = pick && pick.candidate
          if (!candidate) return undefined
          // Drilling into the category: rewrite the token to `@技能/` and keep
          // the menu open so the skill rows load in place. Enter/click arrive as
          // action 'pick', so key off the candidate being a drill row rather
          // than the gesture — otherwise Enter would close the menu doing
          // nothing.
          if (candidate.drill === true) {
            return { text: SKILL_GROUP_TOKEN, continue: true }
          }
          const name = candidate.value || candidate.name
          if (!name || name === SKILL_GROUP) return undefined
          // Settling pick: `/name ` replaces the whole token, so the native
          // skill-loading pre-step sees a plain leading slash command.
          return { text: '/' + name + ' ' }
        },
      }
      try { ctx.effect(() => inputTriggers.registerSource(source), 'skill-forge: @ source') } catch (e) { /* ignore */ }
    }

    // Register a `/skills` client command so the composer's "+" menu (which
    // toggles exactly the 'command' source) can pick a skill too. The popup
    // shell consumes the `/skills` token first, so the write-back is deferred
    // one tick to land on the settled, empty draft.
    function registerSkillCommand(ctx) {
      // ctx.inject waits for the service, so load order cannot silently drop
      // this registration; a host without the service just never enters here.
      const mount = typeof ctx.inject === 'function'
        ? (fn) => ctx.inject(['commandUi'], fn)
        : (fn) => { try { fn(ctx) } catch (e) { /* ignore */ } }
      mount((scope) => {
        let commandUi
        try { commandUi = (scope && scope.commandUi) || (scope && typeof scope.get === 'function' ? scope.get('commandUi') : undefined) } catch (e) { return }
        if (!commandUi || typeof commandUi.register !== 'function') return
        const contribution = {
          name: 'skills',
          label: () => dict().pickSkill || 'Pick a skill',
          description: () => dict().pickSkillHint || 'Insert a skill into the message',
          available: () => true,
          ui: {
            kind: 'popupSelect',
            searchMode: 'fuzzy-label',
            searchLabels: () => ({
              placeholder: dict().filter || 'Filter skills…',
              empty: dict().empty || 'No skills found.',
              noResults: dict().noFilterMatch || 'No skills match this filter.',
            }),
            options: async () => {
              const data = await api('mention', { query: '' })
              return (data.items || []).map(s => ({
                id: s.name,
                label: s.name,
                ...(s.description ? { detail: s.description } : {}),
              }))
            },
            onSelect: (option, session) => {
              const text = '/' + option.id + ' '
              // The popup consumes its `/skills` token right after this returns;
              // defer so the insertion lands on the post-consume draft.
              setTimeout(() => {
                try {
                  const sessions = typeof scope.get === 'function' ? scope.get('sessions') : undefined
                  const conversation = typeof scope.get === 'function' ? scope.get('conversation') : undefined
                  const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(session.sessionId) : undefined
                  if (!binding || !conversation || !conversation.input) return
                  // for() requires the retained Session scope, which is binding.ctx.
                  const input = conversation.input.for(binding.ctx)
                  if (!input) return
                  const snapshot = input.state && typeof input.state.getSnapshot === 'function' ? input.state.getSnapshot() : undefined
                  const cur = String(snapshot && snapshot.draft || '')
                  input.setDraft(cur.trim() === '' ? text : cur.replace(/\s+$/, '') + ' ' + text)
                  input.focus()
                } catch (e) { /* insertion is best-effort; the pick still resolves */ }
              }, 0)
            },
          },
        }
        try { scope.effect(() => commandUi.register(contribution), 'skill-forge: /skills contribution') } catch (e) { /* ignore */ }
      })
    }

    // --- UI strings (no locale-service dependency for labels; also register dicts) ---
    const STRINGS = {
      en: {
        title: 'Skill manager',
        sidebar: 'Skills',
        subtitle: 'Manage installed skills',
        refresh: 'Refresh',
        newSkill: 'New skill',
        name: 'Name',
        description: 'Description',
        source: 'Location',
        status: 'Status',
        actions: 'Actions',
        enabled: 'Visible',
        disabled: 'Hidden',
        view: 'View',
        edit: 'Edit',
        delete: 'Delete',
        create: 'Create',
        close: 'Close',
        builtin: 'Built-in · read-only',
        viewSkill: 'View skill details',
        toggleHint: 'Toggle visibility to the model (disable-model-invocation).',
        deleteSkill: 'Delete skill',
        cancel: 'Cancel',
        save: 'Save',
        content: 'Instructions (Markdown)',
        loading: 'Loading…',
        empty: 'No skills found in the standard roots.',
        confirmDelete: 'Delete this skill? This cannot be undone.',
        openFolder: 'Path',
        created: 'Skill created.',
        saved: 'Saved.',
        deleted: 'Deleted.',
        error: 'Error',
        findGithub: 'Find on GitHub',
        searchGithub: 'Search GitHub skills',
        searchPlaceholder: 'e.g. pdf, react, code review…',
        search: 'Search',
        searching: 'Searching…',
        noResults: 'No repositories found.',
        stars: 'stars',
        useThis: 'Use this',
        startWithKeyword: 'New chat with this keyword',
        keywordHint: 'Adopt a repo to open a "make skill" chat with it as research context.',
        jumpHint: 'Open a "make skill" preset chat with this keyword.',
        openGithub: 'Open on GitHub',
        newSkillHint: 'Enter a topic to open a "make skill" chat and let AI create it.',
        skillTopic: 'Skill topic / keyword',
        startNewChat: 'New chat',
        shownToModel: 'Now visible to the model',
        hiddenFromModel: 'Now hidden from the model',
        enhancing: 'Enhancing prompt with a local model…',
        filter: 'Filter skills…',
        total: 'Total',
        visibleCount: 'Visible',
        hiddenCount: 'Hidden',
        copyPath: 'Copy path',
        copied: 'Path copied.',
        installDirect: 'Install directly',
        installHint: 'Download SKILL.md from the repo into your DSH skills folder, no browser or chat needed.',
        installing: 'Installing…',
        installed: 'Installed',
        installChooseRoot: 'Install into',
        noFilterMatch: 'No skills match this filter.',
        browseSkills: 'Browse installed skills',
        pickSkill: 'Pick a skill',
        pickSkillHint: 'Insert a skill into the message',
      },
      zh: {
        title: '技能管理',
        sidebar: '技能',
        subtitle: '管理已安装的 skill',
        refresh: '刷新',
        newSkill: '新建技能',
        name: '名称',
        description: '描述',
        source: '位置',
        status: '状态',
        actions: '操作',
        enabled: '可见',
        disabled: '隐藏',
        view: '查看',
        edit: '编辑',
        delete: '删除',
        create: '创建',
        close: '关闭',
        builtin: '内置 · 只读',
        viewSkill: '查看技能详情',
        toggleHint: '切换对模型的可见性（disable-model-invocation）。',
        deleteSkill: '删除技能',
        cancel: '取消',
        save: '保存',
        content: '指令正文（Markdown）',
        loading: '加载中…',
        empty: '在标准目录中未找到 skill。',
        confirmDelete: '确定删除这个 skill？此操作无法撤销。',
        openFolder: '路径',
        created: '已创建。',
        saved: '已保存。',
        deleted: '已删除。',
        error: '错误',
        findGithub: '从 GitHub 搜索',
        searchGithub: '搜索 GitHub skill',
        searchPlaceholder: '例如：pdf、react、代码审查…',
        search: '搜索',
        searching: '搜索中…',
        noResults: '未找到相关仓库。',
        stars: '星标',
        useThis: '采用',
        startWithKeyword: '用此关键词新建对话',
        keywordHint: '输入关键词后，将以「制作 skill」预设模式新建会话，由 AI 帮你调研并编写 skill。',
        jumpHint: '输入关键词，直接以「制作 skill」预设模式新建会话。',
        openGithub: '在 GitHub 打开',
        newSkillHint: '输入技能主题，将打开「制作 skill」预设的新对话，并由 AI 按规范帮你创建。',
        skillTopic: '技能主题 / 关键词',
        startNewChat: '新建对话',
        shownToModel: '已设为对模型可见',
        hiddenFromModel: '已设为对模型隐藏',
        enhancing: '正在用本机模型增强提示词…',
        filter: '筛选技能…',
        total: '总数',
        visibleCount: '可见',
        hiddenCount: '隐藏',
        copyPath: '复制路径',
        copied: '路径已复制。',
        installDirect: '直接安装',
        installHint: '从仓库下载 SKILL.md 到你的 DSH 技能目录，无需打开浏览器或新建对话。',
        installing: '安装中…',
        installed: '已安装',
        installChooseRoot: '安装到',
        noFilterMatch: '没有符合筛选条件的技能。',
        browseSkills: '浏览已安装的技能',
        pickSkill: '选择一个技能',
        pickSkillHint: '把技能插入到消息里',
      },
    }
    const dict = () => {
      const lang = (typeof navigator !== 'undefined' && navigator.language || '').toLowerCase()
      return lang.indexOf('zh') === 0 ? STRINGS.zh : STRINGS.en
    }

    // --- styles (theme tokens only, with safe fallbacks) ---
    const CSS = `
.skm-root{height:100%;min-height:0;overflow:auto;padding:24px 28px;box-sizing:border-box;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  font-family:inherit;font-size:14px;line-height:1.5;}
.skm-head{display:flex;align-items:center;gap:10px;margin-bottom:18px;}
.skm-title{margin:0;font-size:20px;font-weight:600;letter-spacing:-.01em;}
.skm-sub{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;}
.skm-grow{flex:1;}
.skm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);border-radius:7px;padding:6px 13px;
  cursor:pointer;font-size:13px;font-weight:500;line-height:1.4;white-space:nowrap;
  transition:background .15s,border-color .15s;}
.skm-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);}
.skm-btn:active:not(:disabled){transform:translateY(1px);}
.skm-btn.primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-color:transparent;}
.skm-btn.primary:hover:not(:disabled){opacity:.88;}
.skm-btn.danger{color:var(--dsw-alias-state-error-primary);}
.skm-btn.danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);}
.skm-btn:disabled{opacity:.45;cursor:default;}
.skm-icon-btn{display:inline-flex;align-items:center;justify-content:center;
  width:30px;height:30px;padding:0;border:1px solid transparent;border-radius:7px;
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;
  transition:background .15s,color .15s,border-color .15s;}
.skm-icon-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);}
.skm-icon-btn.danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);}
.skm-icon-btn.active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.skm-icon-btn:disabled{opacity:.4;cursor:default;}
.skm-icon{width:17px;height:17px;display:block;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
.skm-icon-btn{color:var(--dsw-alias-label-primary);}
.skm-icon-btn.hidden-state{color:var(--dsw-alias-state-warn-primary);}
.skm-table{width:100%;border-collapse:collapse;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;}
.skm-th,.skm-td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle;}
.skm-th{background:var(--dsw-alias-bg-layer-1);font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-label-secondary);font-weight:600;}
.skm-tr:last-child .skm-td{border-bottom:none;}
.skm-tr:hover .skm-td{background:transparent;}
.skm-tr-open .skm-td{background:var(--dsw-alias-bg-layer-1);border-bottom-color:transparent;}
.skm-detail-td{padding:0 12px 14px;background:var(--dsw-alias-bg-layer-1);}
.skm-detail-row:hover .skm-detail-td{background:var(--dsw-alias-bg-layer-1);}
.skm-detail-muted{padding:8px 4px;color:var(--dsw-alias-label-secondary);font-size:12px;}
.skm-detail-err{padding:8px 4px;color:var(--dsw-alias-state-error-primary);font-size:12px;}
.skm-detail-grid{display:grid;grid-template-columns:minmax(180px,260px) 1fr;gap:18px;
  padding:12px 14px;margin:0 2px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;background:var(--dsw-alias-bg-base);}
.skm-detail-k{font-size:10px;text-transform:uppercase;letter-spacing:.05em;
  color:var(--dsw-alias-label-secondary);font-weight:600;margin:8px 0 2px;}
.skm-detail-k:first-child{margin-top:0;}
.skm-detail-v{font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-word;}
.skm-detail-content{min-width:0;}
.skm-code{margin:0;max-height:260px;overflow:auto;padding:10px 12px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}
.skm-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;font-size:13px;}
.skm-path{color:var(--dsw-alias-label-secondary);font-size:11px;opacity:.7;margin-top:2px;word-break:break-all;}
.skm-desc{color:var(--dsw-alias-label-secondary);font-size:12px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.skm-src{white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary);}
.skm-builtin{display:block;margin-top:3px;font-size:10px;white-space:nowrap;color:var(--dsw-alias-label-secondary);opacity:.8;}
.skm-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap;}
.skm-dot{width:7px;height:7px;border-radius:50%;flex:none;}
.skm-dot.on{background:var(--dsw-alias-state-success-primary);}
.skm-dot.off{background:var(--dsw-alias-state-idle-primary);}
.skm-actions{display:flex;gap:2px;justify-content:flex-end;}
.skm-msg{margin:12px 0;padding:9px 13px;border-radius:8px;font-size:13px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}
.skm-msg.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}
.skm-form{display:flex;flex-direction:column;gap:14px;max-width:680px;margin-top:16px;
  padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}
.skm-label{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:5px;display:block;font-weight:500;}
.skm-input,.skm-textarea{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none;
  transition:border-color .15s;}
.skm-input:focus,.skm-textarea:focus{border-color:var(--dsw-alias-brand-primary);}
.skm-input[readonly],.skm-textarea[readonly]{opacity:.8;cursor:default;}
.skm-textarea{min-height:260px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;font-size:12px;line-height:1.6;}
.skm-row{display:flex;gap:10px;align-items:center;}
.skm-toolbar{display:flex;align-items:center;gap:14px;margin:0 0 14px;flex-wrap:wrap;}
.skm-filter{flex:1;min-width:220px;max-width:420px;}
.skm-filter .skm-icon{flex:none;color:var(--dsw-alias-label-secondary);}
.skm-stats{display:flex;gap:14px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-left:auto;}
.skm-gh-actions{display:flex;gap:8px;align-items:center;flex:none;}
.skm-copy{flex:none;}
.skm-nav-icon{display:block;}
/* GitHub search modal */
.skm-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.68);padding:24px;}
.skm-modal{width:min(680px,100%);max-height:86vh;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;
  box-shadow:0 18px 48px rgba(0,0,0,.6);overflow:hidden;}
.skm-modal .skm-input,.skm-modal .skm-btn{background:var(--dsw-alias-bg-base);}
.skm-modal-head{display:flex;align-items:center;gap:8px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.skm-modal-title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;flex:1;}
.skm-modal-body{padding:16px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px;}
.skm-search-row{display:flex;gap:8px;align-items:center;}
.skm-search-row .skm-input{flex:1;}
.skm-modal-actions{display:flex;justify-content:center;padding:10px 0 2px;border-top:1px dashed var(--dsw-alias-border-l1);}
.skm-hint{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5;}
/* suppress browser spellcheck squiggles on all plugin controls */
.skm-root input,.skm-root textarea,.skm-root button{spellcheck:false;}
.skm-gh-results{display:flex;flex-direction:column;gap:8px;margin-top:2px;}
.skm-gh-card{display:flex;gap:12px;align-items:center;padding:11px 12px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;background:var(--dsw-alias-bg-layer-1);}
.skm-gh-card-main{flex:1;min-width:0;}
.skm-gh-name{color:var(--dsw-alias-brand-primary);font-weight:600;font-size:13px;text-decoration:none;}
.skm-gh-name:hover{text-decoration:underline;}
.skm-gh-desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:3px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.skm-gh-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:5px;}
`

    // Small inline SVG icons; stroke inherits currentColor so they follow the theme.
    const ICON_PATHS = {
      doc: h(React.Fragment, null,
        h('path', { d: 'M6 3h8l4 4v14H6z' }),
        h('path', { d: 'M9 12h6M9 16h6' })),
      eye: h(React.Fragment, null,
        h('path', { d: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z' }),
        h('circle', { cx: 12, cy: 12, r: 2.6 })),
      eyeOff: h(React.Fragment, null,
        h('path', { d: 'M3 3l18 18' }),
        h('path', { d: 'M10.6 6.2A10.6 10.6 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.5 7.6A16.7 16.7 0 0 0 2 12s3.6 6 10 6a10.7 10.7 0 0 0 3.4-.5' })),
      trash: h(React.Fragment, null,
        h('path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13' }),
        h('path', { d: 'M10 11v5M14 11v5' })),
      plus: h('path', { d: 'M12 5v14M5 12h14' }),
      copy: h(React.Fragment, null,
        h('rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }),
        h('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' })),
      download: h(React.Fragment, null,
        h('path', { d: 'M12 3v12M7 10l5 5 5-5' }),
        h('path', { d: 'M4 20h16' })),
      refresh: h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6' }),
      external: h(React.Fragment, null,
        h('path', { d: 'M14 4h6v6' }),
        h('path', { d: 'M20 4l-9 9' }),
        h('path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' })),
      search: h(React.Fragment, null,
        h('circle', { cx: 11, cy: 11, r: 7 }),
        h('path', { d: 'M20 20l-4-4' })),
      github: h('path', { d: 'M12 2C6.5 2 2 6.6 2 12.2c0 4.5 2.9 8.3 6.8 9.7.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.2-1.5-1.2-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.7-1.4-2.3-.3-4.8-1.2-4.8-5.4 0-1.2.4-2.2 1.1-2.9-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 2.9 1.1a9.8 9.8 0 0 1 5.2 0c2-1.4 2.9-1.1 2.9-1.1.6 1.5.2 2.6.1 2.9.7.7 1.1 1.7 1.1 2.9 0 4.2-2.5 5.1-4.8 5.4.4.3.7 1 .7 2v3c0 .3.2.6.7.5A10.2 10.2 0 0 0 22 12.2C22 6.6 17.5 2 12 2z' }),
    }
    function Icon({ name }) {
      return h('svg', { className: 'skm-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, ICON_PATHS[name])
    }

    // Open an external URL the way the official chat surface does: prefer a
    // browser tab in the right sidebar when that surface is available, else a
    // plain window.open (which the Electron shell hands to the OS browser).
    function openExternal(url) {
      if (!url) return
      try {
        const sidebarRight = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('sidebarRight') : undefined
        const tabs = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('sidebarRightTabs') : undefined
        if (sidebarRight && typeof sidebarRight.openTab === 'function' && tabs && typeof tabs.get === 'function' && tabs.get('browser') !== undefined) {
          sidebarRight.openTab('browser', { params: { url } })
          return
        }
      } catch (e) { /* fall through to window.open */ }
      try { window.open(url, '_blank', 'noopener,noreferrer') } catch (e) { /* ignore */ }
    }

    // GitHub skill search modal. Search results are shown as repository cards;
    // adopting one launches the "制作 skill" preset with the repo as context.
    function GithubModal({ t, query, setQuery, items, loading, enhancing, installingRepo, onSearch, onUse, onInstall, onJump, onClose }) {
      const onKeyDown = (e) => { if (e.key === 'Enter') { e.preventDefault(); onSearch() } }
      return h('div', { className: 'skm-overlay', onMouseDown: onClose },
        h('div', { className: 'skm-modal', role: 'dialog', 'aria-modal': 'true', onMouseDown: e => e.stopPropagation() },
          h('div', { className: 'skm-modal-head' },
            h('div', { className: 'skm-modal-title' }, h(Icon, { name: 'github' }), t.searchGithub),
            h('button', { className: 'skm-icon-btn', 'aria-label': t.close, onClick: onClose }, '✕'),
          ),
          h('div', { className: 'skm-modal-body' },
            // One input for both actions; Enter runs the GitHub search.
            h('div', { className: 'skm-search-row' },
              h('input', {
                className: 'skm-input', value: query, placeholder: t.searchPlaceholder,
                spellCheck: false, autoComplete: 'off',
                onChange: e => setQuery(e.target.value), onKeyDown,
              }),
              h('button', {
                className: 'skm-btn primary', onClick: onSearch, disabled: loading || !query.trim(),
              }, loading ? t.searching : t.search),
            ),
            h('div', { className: 'skm-modal-actions' },
              enhancing
                ? h('div', { className: 'skm-detail-muted' }, t.enhancing)
                : h('button', {
                  className: 'skm-btn', onClick: () => onJump(query), disabled: !query.trim(),
                  title: t.jumpHint, spellCheck: false,
                }, h(Icon, { name: 'plus' }), t.startWithKeyword),
            ),
            h('div', { className: 'skm-gh-results' },
              loading ? h('div', { className: 'skm-detail-muted' }, t.searching)
                : items.length === 0 ? h('div', { className: 'skm-detail-muted' }, t.noResults)
                  : items.map(repo => h('div', { className: 'skm-gh-card', key: repo.fullName },
                    h('div', { className: 'skm-gh-card-main' },
                      h('a', {
                        className: 'skm-gh-name', href: repo.htmlUrl, target: '_blank', rel: 'noopener noreferrer',
                      }, repo.fullName),
                      h('div', { className: 'skm-gh-desc' }, repo.description || '—'),
                      h('div', { className: 'skm-gh-meta' },
                        h('span', null, '★ ' + repo.stars + ' ' + t.stars),
                        repo.language && h('span', null, ' · ' + repo.language),
                      ),
                    ),
                    h('div', { className: 'skm-gh-actions' },
                      h('button', {
                        className: 'skm-icon-btn', title: t.openGithub, 'aria-label': t.openGithub,
                        onClick: () => openExternal(repo.htmlUrl),
                      }, h(Icon, { name: 'external' })),
                      h('button', {
                        className: 'skm-btn', title: t.installHint,
                        disabled: !!installingRepo,
                        onClick: () => onInstall(repo),
                      }, h(Icon, { name: 'download' }), installingRepo === repo.fullName ? t.installing : t.installDirect),
                      h('button', {
                        className: 'skm-btn primary', onClick: () => onUse(query || repo.name, repo),
                      }, t.useThis),
                    ),
                  )),
            ),
          ),
        ),
      )
    }

    function SkillManagerPage(props) {
      const t = dict()
      const [skills, setSkills] = React.useState([])
      const [roots, setRoots] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [message, setMessage] = React.useState(null)
      const [error, setError] = React.useState(null)
      // create form lives at the top; detail is expanded inline under its own row
      const [creating, setCreating] = React.useState(null) // {name, source, description, content}
      const [details, setDetails] = React.useState({})    // key -> {content, frontmatter, raw} | {loading:true}
      const [expanded, setExpanded] = React.useState(null) // key of the expanded row
      const [ghOpen, setGhOpen] = React.useState(false)    // GitHub search modal
      const [ghQuery, setGhQuery] = React.useState('')
      const [ghItems, setGhItems] = React.useState([])
      const [ghLoading, setGhLoading] = React.useState(false)
      const [enhancing, setEnhancing] = React.useState(false)
      const [filter, setFilter] = React.useState('')       // local skill filter text
      const [installingRepo, setInstallingRepo] = React.useState(null) // fullName being installed

      const load = React.useCallback(async () => {
        setLoading(true); setError(null)
        try {
          const data = await api('list')
          setSkills(data.skills || [])
          setRoots(data.roots || [])
        } catch (e) {
          setError(String(e && e.message || e))
        } finally {
          setLoading(false)
        }
      }, [])
      React.useEffect(() => { load() }, [load])

      const notify = (msg) => { setMessage(msg); setTimeout(() => setMessage(null), 2500) }
      const run = async (op, extra, successMsg) => {
        setError(null)
        try {
          await api(op, extra)
          if (successMsg) notify(successMsg)
          await load()
        } catch (e) {
          setError(String(e && e.message || e))
        }
      }

      const rowKey = (s) => s.source + '|' + s.name

      // Derived: filtered skill list + counters (total / visible / hidden).
      const filterText = filter.trim().toLowerCase()
      const visibleSkills = filterText
        ? skills.filter(s => [s.name, s.description, s.sourceLabel || s.source].some(v => String(v || '').toLowerCase().includes(filterText)))
        : skills
      const totalCount = skills.length
      const hiddenCount = skills.filter(s => s.disabled).length
      const shownCount = visibleSkills.length

      const copyPath = async (p) => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(p)
          else {
            const ta = document.createElement('textarea'); ta.value = p; document.body.appendChild(ta)
            ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
          }
          notify(t.copied || 'Path copied.')
        } catch (e) {
          setError(String(e && e.message || e))
        }
      }

      // Install a GitHub repo's SKILL.md files directly, no browser/chat needed.
      const installRepo = async (repo) => {
        if (!repo || !repo.fullName) return
        setInstallingRepo(repo.fullName)
        setError(null)
        try {
          const data = await api('installFromGithub', {
            fullName: repo.fullName,
            defaultBranch: repo.defaultBranch,
          })
          if (!data.ok) throw new Error(data.error || 'install failed')
          await load()
          notify(data.message || (t.installed + ' ' + repo.fullName))
          setGhOpen(false)
        } catch (e) {
          setError(String(e && e.message || e))
        } finally {
          setInstallingRepo(null)
        }
      }

      const toggleDetail = async (skill) => {
        const key = rowKey(skill)
        if (expanded === key) {           // clicking again collapses the row
          setExpanded(null)
          return
        }
        setExpanded(key)
        if (details[key] && !details[key].loading) return // already cached
        setDetails(prev => Object.assign({}, prev, { [key]: { loading: true } }))
        setError(null)
        try {
          const q = '?name=' + encodeURIComponent(skill.name) + '&source=' + encodeURIComponent(skill.source)
          const res = await fetch(API + q)
          const data = await res.json()
          if (!data.ok) throw new Error(data.error || 'load failed')
          setDetails(prev => Object.assign({}, prev, { [key]: data.skill }))
        } catch (e) {
          setDetails(prev => Object.assign({}, prev, { [key]: { error: String(e && e.message || e) } }))
        }
      }

      // "新建技能" now opens a new conversation in the "制作 skill" preset,
      // with a bundled prompt template prefilled. The keyword box in the form
      // below collects the topic before jumping.
      const startCreate = () => {
        setExpanded(null)
        setCreating({ keyword: '' })
      }

      // Open a new session under the "制作 skill" preset with a prefilled prompt.
      // Uses the official Client service ctx.uiWorkspace.startSession(workspaceId, options).
      const startWithKeyword = async (keyword, repo) => {
        const kw = String(keyword || '').trim()
        if (!kw) { notify(t.keywordRequired || '请输入关键词'); return }
        // uiWorkspace is declared in this module's inject list, so direct access
        // is safe here; ctx.get() is kept as a defensive fallback.
        let uiWorkspace
        try { uiWorkspace = (clientCtx && clientCtx.uiWorkspace) || (clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('uiWorkspace') : undefined) } catch (e) { uiWorkspace = undefined }
        if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') {
          setError('当前宿主未能提供会话导航服务，无法直接打开预设会话。请升级 DSH 后重试。')
          return
        }
        let prompt
        if (repo) {
          prompt = [
            '请帮我基于下面的 GitHub 仓库制作一个 DSH skill。',
            '',
            '关键词：' + kw,
            '仓库：' + (repo.fullName || ''),
            '链接：' + (repo.htmlUrl || ''),
            '简介：' + (repo.description || '（无）'),
            '',
            '请先调研这个仓库（必要时克隆到临时目录阅读），提炼出可复用的任务模式，再按 DSH skill 规范创建：目录式 <name>/SKILL.md，frontmatter 含 name 与 description，正文为给模型的可执行指令。完成后说明 skill 名称、位置与触发场景。',
          ].join('\n')
        } else {
          prompt = SKILL_PROMPT_TEMPLATE.replace('{kw}', kw)
        }

        // Try to enhance the prompt with an available model; on any failure
        // (no model configured, timeout, error) keep the original prompt.
        const basePrompt = prompt
        setEnhancing(true)
        try {
          const data = await api('enhancePrompt', { topic: kw, prompt: basePrompt })
          if (data && data.ok === true && typeof data.prompt === 'string' && data.prompt.trim()) {
            prompt = data.prompt.trim()
          }
        } catch (e) {
          // fall back to the original prompt silently
        } finally {
          setEnhancing(false)
        }

        try {
          uiWorkspace.startSession(undefined, {
            agentPreset: 'make-skill',
            prompt,
            whenDraftExists: 'replace',
          })
          setGhOpen(false)
          setCreating(null)
        } catch (e) {
          setError(String(e && e.message || e))
        }
      }

      const doGithubSearch = async () => {
        const q = ghQuery.trim()
        if (!q) return
        setGhLoading(true); setError(null)
        try {
          const data = await api('searchGithub', { query: q })
          setGhItems(data.items || [])
          if (!data.ok && data.error) setError(data.error)
        } catch (e) {
          setError(String(e && e.message || e))
          setGhItems([])
        } finally {
          setGhLoading(false)
        }
      }

      return h('div', { className: 'skm-root' },
        h('style', null, CSS),
        h('div', { className: 'skm-head' },
          h('div', null,
            h('h2', { className: 'skm-title' }, t.title),
            h('p', { className: 'skm-sub' }, t.subtitle),
          ),
          h('div', { className: 'skm-grow' }),
          h('button', {
            className: 'skm-icon-btn', title: t.refresh, 'aria-label': t.refresh,
            onClick: load, disabled: loading,
          }, h(Icon, { name: 'refresh' })),
          h('button', {
            className: 'skm-btn', onClick: () => { setCreating(null); setGhOpen(true); setError(null) },
          }, h(Icon, { name: 'search' }), t.findGithub),
          h('button', {
            className: 'skm-btn primary', onClick: startCreate,
          }, h(Icon, { name: 'plus' }), t.newSkill),
        ),
        h('div', { className: 'skm-toolbar' },
          h('div', { className: 'skm-search-row skm-filter' },
            h(Icon, { name: 'search' }),
            h('input', {
              className: 'skm-input', value: filter, placeholder: t.filter,
              spellCheck: false, autoComplete: 'off',
              onChange: e => setFilter(e.target.value),
            }),
          ),
          h('div', { className: 'skm-stats' },
            h('span', null, t.total + ': ' + totalCount),
            h('span', null, t.visibleCount + ': ' + (totalCount - hiddenCount)),
            h('span', null, t.hiddenCount + ': ' + hiddenCount),
          ),
        ),
        enhancing && h('div', { className: 'skm-msg' }, t.enhancing),
        message && h('div', { className: 'skm-msg' }, message),
        error && h('div', { className: 'skm-msg err' }, t.error + ': ' + error),
        creating && h('div', { className: 'skm-form' },
          h('div', { className: 'skm-head', style: { marginBottom: 0 } },
            h('h3', { className: 'skm-title', style: { fontSize: 15 } }, t.newSkill),
            h('div', { className: 'skm-grow' }),
          ),
          h('p', { className: 'skm-hint' }, t.newSkillHint),
          h('div', null,
            h('label', { className: 'skm-label' }, t.skillTopic),
            h('input', {
              className: 'skm-input', value: creating.keyword,
              placeholder: t.searchPlaceholder,
              spellCheck: false, autoComplete: 'off',
              onChange: e => setCreating(Object.assign({}, creating, { keyword: e.target.value })),
              onKeyDown: e => {
                if (e.key === 'Enter' && creating.keyword.trim()) startWithKeyword(creating.keyword.trim(), null)
              },
            }),
          ),
          h('div', { className: 'skm-row' },
            h('button', {
              className: 'skm-btn primary',
              disabled: !creating.keyword.trim(),
              onClick: () => startWithKeyword(creating.keyword.trim(), null),
            }, h(Icon, { name: 'plus' }), t.startNewChat),
            h('button', { className: 'skm-btn', onClick: () => setCreating(null) }, t.cancel),
          ),
        ),
        loading ? h('div', { className: 'skm-msg' }, t.loading) :
          h('table', { className: 'skm-table' },
            h('thead', null, h('tr', null,
              h('th', { className: 'skm-th', style: { width: '22%' } }, t.name),
              h('th', { className: 'skm-th' }, t.description),
              h('th', { className: 'skm-th', style: { width: '110px' } }, t.source),
              h('th', { className: 'skm-th', style: { width: '84px' } }, t.status),
              h('th', { className: 'skm-th', style: { width: '118px', textAlign: 'right' } }, t.actions),
            )),
            h('tbody', null, skills.length === 0
              ? h('tr', null, h('td', { className: 'skm-td', colSpan: 5 }, t.empty))
              : visibleSkills.length === 0
                ? h('tr', null, h('td', { className: 'skm-td', colSpan: 5 }, t.noFilterMatch))
                : visibleSkills.flatMap(s => {
                const key = rowKey(s)
                const isOpen = expanded === key
                const d = details[key]
                const mainRow = h('tr', { key: key, className: 'skm-tr' + (isOpen ? ' skm-tr-open' : '') },
                  h('td', { className: 'skm-td' },
                    h('div', { className: 'skm-name' }, s.name),
                    h('div', { className: 'skm-path' }, s.path),
                  ),
                  h('td', { className: 'skm-td' },
                    h('div', { className: 'skm-desc' }, s.description || '—'),
                  ),
                  h('td', { className: 'skm-td' },
                    h('span', { className: 'skm-src' }, s.sourceLabel || s.source),
                    s.managed === false && h('span', { className: 'skm-builtin' }, t.builtin),
                  ),
                  h('td', { className: 'skm-td' },
                    h('span', { className: 'skm-status' },
                      h('span', { className: 'skm-dot ' + (s.disabled ? 'off' : 'on') }),
                      s.disabled ? t.disabled : t.enabled,
                    ),
                  ),
                  h('td', { className: 'skm-td' },
                    h('div', { className: 'skm-actions' },
                      h('button', {
                        className: 'skm-icon-btn' + (isOpen ? ' active' : ''), title: t.viewSkill,
                        'aria-label': t.viewSkill, 'aria-expanded': isOpen ? 'true' : 'false',
                        onClick: () => toggleDetail(s),
                      }, h(Icon, { name: 'doc' })),
                      s.managed !== false && h('button', {
                        className: 'skm-icon-btn' + (s.disabled ? ' hidden-state' : ''), disabled: !s.hasFrontmatter,
                        title: s.hasFrontmatter ? t.toggleHint : 'no frontmatter',
                        'aria-label': s.disabled ? t.enabled : t.disabled,
                        onClick: () => run('setEnabled',
                          { name: s.name, source: s.source, enabled: !!s.disabled },
                          s.disabled ? t.shownToModel : t.hiddenFromModel),
                      }, h(Icon, { name: s.disabled ? 'eye' : 'eyeOff' })),
                      s.managed !== false && h('button', {
                        className: 'skm-icon-btn danger', title: t.deleteSkill,
                        'aria-label': t.deleteSkill,
                        onClick: () => {
                          if (typeof window !== 'undefined' && !window.confirm(t.confirmDelete)) return
                          run('delete', { name: s.name, source: s.source }, t.deleted)
                        },
                      }, h(Icon, { name: 'trash' })),
                    ),
                  ),
                )
                if (!isOpen) return [mainRow]
                // inline detail row directly beneath the skill
                const detailBody = !d
                  ? h('div', { className: 'skm-detail-muted' }, t.loading)
                  : d.error
                    ? h('div', { className: 'skm-detail-err' }, d.error)
                    : h('div', { className: 'skm-detail-grid' },
                      h('div', { className: 'skm-detail-meta' },
                        h('div', { className: 'skm-detail-k' }, t.name),
                        h('div', { className: 'skm-detail-v' }, d.frontmatter?.name || s.name),
                        h('div', { className: 'skm-detail-k' }, t.description),
                        h('div', { className: 'skm-detail-v' }, d.frontmatter?.description || '—'),
                        h('div', { className: 'skm-detail-k' }, t.openFolder),
                        h('div', { className: 'skm-detail-v skm-row' },
                          h('span', { className: 'skm-path', style: { flex: 1 } }, d.path),
                          h('button', {
                            className: 'skm-icon-btn skm-copy', title: t.copyPath, 'aria-label': t.copyPath,
                            onClick: () => copyPath(d.path),
                          }, h(Icon, { name: 'copy' })),
                        ),
                      ),
                      h('div', { className: 'skm-detail-content' },
                        h('div', { className: 'skm-detail-k' }, t.content),
                        h('pre', { className: 'skm-code' }, d.content || ''),
                      ),
                    )
                const detailRow = h('tr', { key: key + '-detail', className: 'skm-detail-row' },
                  h('td', { colSpan: 5, className: 'skm-detail-td' }, detailBody),
                )
                return [mainRow, detailRow]
              }),
            ),
          ),
        ghOpen && h(GithubModal, {
          t, query: ghQuery, setQuery: setGhQuery, items: ghItems, loading: ghLoading, enhancing,
          installingRepo,
          onSearch: doGithubSearch,
          onUse: (kw, repo) => startWithKeyword(kw, repo),
          onInstall: installRepo,
          onJump: (kw) => startWithKeyword(kw, null),
          onClose: () => setGhOpen(false),
        }),
      )
    }

    function SidebarIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 18
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        className: 'skm-nav-icon', 'aria-hidden': 'true', focusable: 'false',
        style: { display: 'block' },
      },
        h('path', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          d: 'M4 6h6l2 2h8v11H4z' }),
        h('path', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round',
          d: 'M8 13h6M8 16h4' }),
      )
    }

    return {
      // uiWorkspace provides startSession(); inputTriggers provides the "@ skill"
      // source. Both are shipped DSH Client services (also in dsh.client.inject).
      // commandUi/sessions are looked up softly via ctx.get() inside
      // registerSkillCommand so a missing one degrades that feature alone
      // instead of blocking the whole client module.
      inject: ['slots', 'uiWorkspace', 'inputTriggers'],
      apply(ctx) {
        clientCtx = ctx
        // @ skill mention source and the /skills command are independent of the
        // sidebar slots, so register them even if the slots are unavailable.
        registerSkillMentionSource(ctx)
        registerSkillCommand(ctx)
        const slots = (() => { try { return ctx.slots ?? ctx.get?.('slots') } catch (e) { return undefined } })()
        const layout = (() => { try { return ctx.layout ?? ctx.get?.('layout') } catch (e) { return undefined } })()
        if (!slots || typeof slots.inject !== 'function') return

        // 1) Left-sidebar entry + central panel (primary).
        try {
          slots.inject('sidebar.panellist', () => slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            label: () => dict().sidebar,
          }, SidebarIcon))
          slots.inject('main', () => slots.register({
            name: 'main',
            key: PANEL_ID,
          }, SkillManagerPage))
        } catch (error) {
          console.error('[dsh-skill-forge] sidebar entry unavailable:', error)
        }

        // Expose a tiny client-side control surface for other plugins / debugging.
        try {
          if (typeof ctx.provide === 'function') {
            ctx.provide('skillManager', Object.freeze({
              open: () => { try { layout?.selectPanel?.(PANEL_ID) } catch (e) { /* ignore */ } },
              api,
            }))
          }
        } catch (e) { /* ignore */ }
      },
    }
  },
})
