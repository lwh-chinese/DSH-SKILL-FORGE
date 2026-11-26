/**
 * dsh-skill-forge — Host half.
 *
 * Registers a small JSON HTTP API (`/dsh-skill-forge-api`) on the Web server.
 * The Client panel calls it to list / read / enable / disable / create / delete
 * installed skills. All file access is rooted in the documented DSH skill roots,
 * and every path is validated so no operation can escape those roots.
 *
 * Compatibility: uses soft service lookup (`ctx.get`), optional chaining and
 * guarded registration. If a host does not expose `webServer` (or an older DSH
 * build lacks a feature), this plugin simply stays inert instead of throwing.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'

export const inject = ['webServer']

const ROUTE = '/dsh-skill-forge-api'
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'off', '0'])

/** Parse the YAML-ish frontmatter keys we care about without pulling in a YAML lib. */
function parseFrontmatter(text) {
  const result = {}
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text)
  if (!match) return { frontmatter: result, body: text, hasFrontmatter: false }
  let key = null
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) {
      key = kv[1]
      let value = kv[2]
      // strip simple quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      result[key] = value
      continue
    }
    // continuation of a folded scalar (e.g. description on next line) — keep it simple
    if (key && /^\s+/.test(raw) && raw.trim()) {
      result[key] = String(result[key] || '') + ' ' + raw.trim()
    } else {
      key = null
    }
  }
  return { frontmatter: result, body: text.slice(match[0].length), hasFrontmatter: true }
}

function boolValue(value, fallback) {
  if (value === undefined) return fallback
  const s = String(value).trim().toLowerCase()
  if (TRUE_WORDS.has(s)) return true
  if (FALSE_WORDS.has(s)) return false
  return fallback
}

function serializeFrontmatter(fm, body) {
  const lines = ['---']
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null || v === '') continue
    // quote values containing ':' or '#' to stay valid YAML
    const str = String(v)
    lines.push(`${k}: ${/[:#\n]/.test(str) ? JSON.stringify(str) : str}`)
  }
  lines.push('---', '')
  return lines.join('\n') + body
}

/**
 * Patch one top-level frontmatter key textually, preserving every other line
 * verbatim (comments, block scalars, lists, maps). This avoids the corruption a
 * parse-and-reserialize round trip would cause on complex frontmatter.
 * Returns the original text unchanged when the block has no frontmatter.
 */
function patchFrontmatterKey(text, key, value) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text)
  if (!match) return text
  const block = match[1]
  const nl = match[0].includes('\r\n') ? '\r\n' : '\n'
  const lines = block.split(/\r?\n/)
  const keyRe = new RegExp('^(\\s*' + key + '\\s*:\\s*).*$')
  let replaced = false
  const out = lines.map(line => {
    const m = keyRe.exec(line)
    if (!m) return line
    replaced = true
    return m[1] + String(value)
  })
  if (!replaced) out.push(key + ': ' + String(value))
  const rest = text.slice(match[0].length)
  return '---' + nl + out.join(nl) + nl + '---' + nl + rest
}

/** Build the ordered list of skill roots (mirrors dsh-skill-filesystem ranks). */
function skillRoots(home) {
  const dshHome = home.dsh || path.join(os.homedir(), '.dsh')
  const agentsHome = home.agents || path.join(os.homedir(), '.agents')
  const cwd = home.cwd || process.cwd()
  const roots = [
    { id: 'project-dsh', label: '项目 · .dsh/skills', dir: path.join(cwd, '.dsh', 'skills') },
    { id: 'project-agents', label: '项目 · .agents/skills', dir: path.join(cwd, '.agents', 'skills') },
    { id: 'user-dsh', label: '用户 · DSH skills', dir: path.join(dshHome, 'skills') },
    { id: 'user-agents', label: '用户 · agents skills', dir: path.join(agentsHome, 'skills') },
  ]
  // custom dirs from config, if provided
  for (const dir of home.customDirs || []) {
    if (typeof dir === 'string' && dir.trim()) {
      roots.push({ id: 'custom', label: '自定义目录', dir: path.resolve(dir) })
    }
  }
  return roots
}

/** Enumerate a single root: directory bundles (<name>/SKILL.md) and flat <name>.md. */
function scanRoot(root) {
  const skills = []
  let entries = []
  try {
    entries = fs.readdirSync(root.dir, { withFileTypes: true })
  } catch {
    return skills
  }
  for (const entry of entries) {
    try {
      // A junction/symlink reports isDirectory()===false; follow it with statSync
      // so linked skill bundles (DSH supports them) are discovered too.
      const full = path.join(root.dir, entry.name)
      let isDir = entry.isDirectory()
      if (!isDir && entry.isSymbolicLink()) {
        try { isDir = fs.statSync(full).isDirectory() } catch { /* dangling link */ }
      }
      if (isDir && entry.name !== '.system') {
        const file = path.join(full, 'SKILL.md')
        if (fs.existsSync(file)) skills.push(readSkill(file, root, 'directory'))
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const name = entry.name.slice(0, -3)
        if (NAME_RE.test(name)) {
          skills.push(readSkill(full, root, 'flat'))
        }
      }
    } catch {
      /* skip unreadable entry */
    }
  }
  return skills.filter(Boolean)
}

function readSkill(file, root, kind) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const { frontmatter, body, hasFrontmatter } = parseFrontmatter(text)
  const name = frontmatter.name || (kind === 'flat' ? path.basename(file, '.md') : path.basename(path.dirname(file)))
  const modelHidden = boolValue(frontmatter['disable-model-invocation'], false)
  return {
    name,
    description: frontmatter.description || '',
    whenToUse: frontmatter.whenToUse || '',
    source: root.id,
    sourceLabel: root.label,
    kind,
    path: file,
    // "hidden" reflects DSH's real key `disable-model-invocation`: when true the
    // skill is excluded from the model-facing catalog and loader.
    disabled: modelHidden,
    modelInvocable: !modelHidden,
    userInvocable: boolValue(frontmatter['user-invocable'], true),
    hasFrontmatter,
    bodyLength: body.length,
  }
}

function homeInfo(config) {
  const cfg = config || {}
  return {
    dsh: cfg.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    agents: cfg.agentsHome || process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'),
    cwd: cfg.cwd || process.cwd(),
    customDirs: cfg.customSkillDirs || [],
  }
}

const SOURCE_LABELS = {
  'project-dsh': '项目 · .dsh/skills',
  'project-agents': '项目 · .agents/skills',
  custom: '自定义目录',
  'user-dsh': '用户 · DSH skills',
  'user-agents': '用户 · agents skills',
  bundled: '内置 · DSH',
  runtime: '内置 · 运行时',
}

function labelForSource(source) {
  return SOURCE_LABELS[source] || source || '未知来源'
}

/**
 * Build the skill list from two sources:
 *  1. disk roots (managed: path, frontmatter, enable/delete/create)
 *  2. DSH's own `ctx.skills` registry — the authoritative view that also
 *     includes bundled skills shipped inside the ASAR and runtime registrations.
 * Registry-only skills are shown as read-only (managed:false) because their
 * files are not under our writable roots.
 */
async function listSkills(config, skillsSvc) {
  const info = homeInfo(config)
  const roots = skillRoots(info)
  const byName = new Map()
  for (const root of roots) {
    for (const skill of scanRoot(root)) {
      // nearest/highest-priority root wins for a given name
      if (!byName.has(skill.name)) byName.set(skill.name, Object.assign({ managed: true }, skill))
    }
  }

  if (skillsSvc && typeof skillsSvc.list === 'function') {
    let summaries = []
    try {
      summaries = await skillsSvc.list({ cwd: info.cwd }) || []
    } catch (error) {
      // registry absent or discovery failed — the disk list still works
    }
    for (const s of summaries) {
      if (!s || !s.name || byName.has(s.name)) continue
      const modelInvocable = !!(s.invocation && s.invocation.modelInvocable)
      byName.set(s.name, {
        name: s.name,
        description: s.description || '',
        whenToUse: s.whenToUse || '',
        source: s.source || 'runtime',
        sourceLabel: labelForSource(s.source),
        kind: 'builtin',
        path: s.path || '',
        disabled: !modelInvocable,
        modelInvocable,
        userInvocable: !!(s.invocation && s.invocation.userInvocable),
        hasFrontmatter: false,
        managed: false,
        bodyLength: 0,
      })
    }
  }

  const all = [...byName.values()]
  all.sort((a, b) => a.name.localeCompare(b.name) || String(a.source).localeCompare(String(b.source)))
  return { skills: all, roots: roots.map(r => ({ id: r.id, label: r.label, dir: r.dir })) }
}

function isInside(root, target) {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function findSkillFile(config, name, sourceId) {
  const roots = skillRoots(homeInfo(config))
  const candidates = sourceId ? roots.filter(r => r.id === sourceId) : roots
  for (const root of candidates) {
    const dirFile = path.join(root.dir, name, 'SKILL.md')
    const flatFile = path.join(root.dir, name + '.md')
    if (fs.existsSync(dirFile)) return { file: dirFile, root }
    if (fs.existsSync(flatFile)) return { file: flatFile, root }
  }
  return null
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => {
      data += chunk
      if (data.length > 2 * 1024 * 1024) reject(new Error('payload too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

/** Native HTTPS GET returning parsed JSON; falls back to relaxed TLS on MITM proxies. */
function httpsGetJson(url, headers) {
  const perform = (rejectUnauthorized) => new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000, rejectUnauthorized }, (res) => {
      let data = ''
      res.on('data', chunk => {
        data += chunk
        if (data.length > 4 * 1024 * 1024) req.destroy(new Error('response too large'))
      })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: parseJsonBody(data), headers: res.headers })
        } catch (error) {
          reject(new Error('invalid JSON from GitHub: ' + error.message))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('GitHub 请求超时')))
    req.on('error', reject)
  })
  return perform(true).catch(error => {
    if (/UNABLE_TO_VERIFY|CERT|SELF_SIGNED/i.test(String(error && error.message))) {
      return perform(false) // tolerate corporate MITM / self-signed root
    }
    throw error
  })
}

function parseJsonBody(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new Error('GitHub 返回了非 JSON 响应（可能是速率限制或代理拦截），请稍后重试。')
  }
  return JSON.parse(trimmed)
}

/**
 * Fetch JSON from GitHub. Native https is primary (it proved reliable against
 * the deployment's MITM proxy); DSH's web service is a fallback. Retries once
 * on transient non-JSON/HTML responses.
 */
async function fetchGithubJson(url, headers, webSvc) {
  const attempt = async () => {
    try {
      return await httpsGetJson(url, headers)
    } catch (error) {
      if (webSvc && typeof webSvc.fetch === 'function') {
        try {
          const result = await webSvc.fetch({ url, headers })
          if (result && result.body) {
            return { status: result.status ?? 200, json: parseJsonBody(result.body) }
          }
          if (result && result.error) throw new Error(result.error.message || String(result.error))
        } catch (inner) { /* fall through */ }
      }
      throw error
    }
  }
  try {
    return await attempt()
  } catch (error) {
    // Retry once after a short pause for transient HTML/rate-limit responses.
    await new Promise(resolve => setTimeout(resolve, 600))
    return attempt()
  }
}

/**
 * Enhance a user's short skill topic into a detailed prompt using an available
 * local/configured model. Returns null when no usable provider/model exists or
 * generation fails, so the caller can fall back to the original prompt.
 * `getLlm` is injected so this stays testable and uses a soft service lookup.
 */
async function enhancePromptText(topic, rawPrompt, getLlm, diag) {
  const llm = typeof getLlm === 'function' ? getLlm() : undefined
  if (!llm || typeof llm.stream !== 'function' || typeof llm.listProviders !== 'function') return null
  const attempts = []
  try {
    const providers = llm.listProviders() || []
    if (!providers.length) { if (diag) diag.reason = 'no live provider'; return null }

    // Third-party / free model plugins (ourfreemodel, workbuddy, ...) are valid
    // providers too. Prefer first-party routes first, then try EVERY remaining
    // provider so a balance/auth failure on one does not block the others.
    const preferred = ['deepseek-official', 'deepseek-account', 'deepseek-api-key', 'pi-ai']
    const ordered = []
    for (const id of preferred) {
      for (const p of providers) if (p.id === id && !ordered.includes(p)) ordered.push(p)
    }
    for (const p of providers) if (!ordered.includes(p)) ordered.push(p)

    // Collect (provider, model) candidates: first model of each provider, then
    // remaining models, so we try one model per provider before exhausting a
    // single provider's list.
    const candidates = []
    const perProvider = new Map()
    for (const p of ordered) {
      try {
        const models = (await llm.listModels(p.id)) || []
        const ids = models.map(m => m.id).filter(Boolean)
        perProvider.set(p.id, ids.length)
        for (const mid of ids) candidates.push({ provider: p.id, model: mid })
      } catch (e) {
        perProvider.set(p.id, 0)
      }
    }
    // Round-robin: pick first model of each provider, then second, etc.
    const maxLen = Math.max(0, ...[...perProvider.values()])
    const roundRobin = []
    for (let i = 0; i < maxLen; i++) {
      for (const p of ordered) {
        const ids = []
        for (const c of candidates) if (c.provider === p.id) ids.push(c.model)
        if (ids[i]) roundRobin.push({ provider: p.id, model: ids[i] })
      }
    }
    if (!roundRobin.length) { if (diag) diag.reason = 'no provider exposed any model'; return null }
    if (diag) diag.providers = Object.fromEntries(perProvider)

    const sys = [
      'You rewrite short user requests into a single, clear, self-contained instruction for an AI agent that creates DeepSeek Harness (DSH) skills.',
      'Rules:',
      '- Keep the user\'s original intent and language (Chinese input -> Chinese output).',
      '- Do NOT answer the task; only output the improved instruction text.',
      '- Make the instruction concrete and actionable: ask the agent to research existing conventions, then create a directory-style skill (<name>/SKILL.md) with a kebab-case name, required frontmatter (name and description) and a clear description of when to use it, plus executable step-by-step instructions in the body.',
      '- Ask it to avoid hard-coded one-off paths and to keep instructions reusable.',
      '- Output only the improved instruction, no preamble, no quotes, no markdown fences.',
    ].join('\n')
    const userText = [
      'User topic: ' + String(topic || '').trim(),
      '',
      'Current draft instruction:',
      String(rawPrompt || '').trim(),
      '',
      'Rewrite the draft into one improved instruction now.',
    ].join('\n')

    // Overall budget so several failing providers cannot hang the UI.
    const deadline = Date.now() + 45000
    for (const cand of roundRobin) {
      if (Date.now() > deadline) { if (diag) diag.reason = 'time budget exhausted'; return null }
      let text = ''
      const controller = new AbortController()
      const remaining = Math.max(1000, deadline - Date.now())
      const timer = setTimeout(() => controller.abort(), Math.min(remaining, 20000))
      try {
        for await (const chunk of llm.stream({
          provider: cand.provider, model: cand.model,
          system: sys,
          messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
          maxTokens: 700,
          signal: controller.signal,
        })) {
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (chunk && chunk.type === 'finish' && chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
            attempts.push(cand.provider + '/' + cand.model + ': ' + chunk.reason.kind + ' ' + ((chunk.reason.failure && chunk.reason.failure.message) || ''))
            break // try next candidate
          }
        }
      } catch (e) {
        attempts.push(cand.provider + '/' + cand.model + ': exception ' + (e instanceof Error ? e.message : String(e)))
      } finally {
        clearTimeout(timer)
      }
      const trimmed = text.trim()
      if (trimmed) {
        if (diag) { diag.provider = cand.provider; diag.model = cand.model }
        return trimmed
      }
    }
    if (diag) { diag.reason = 'all candidates failed'; diag.attempts = attempts.slice(0, 8) }
    return null
  } catch (error) {
    if (diag) diag.reason = 'exception: ' + (error instanceof Error ? error.message : String(error))
    return null
  }
}

export function apply(ctx, config = {}) {
  const webServer = ctx.webServer ?? ctx.get?.('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[dsh-skill-forge] webServer unavailable; management API not mounted')
    return
  }
  // DSH's skill registry is the authoritative catalog (bundled + filesystem +
  // runtime). It is optional: older hosts without it still see disk skills.
  // Use the soft lookup only: direct `ctx.skills` would require declaring an
  // inject and make the plugin fail to activate on hosts without that service.
  const skillsSvc = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  // DSH's web service uses the deployment's configured network stack (proxy/CA).
  const webSvc = typeof ctx.get === 'function' ? ctx.get('web') : undefined
  // Optional LLM runtime for prompt enhancement. Soft lookup: when no model is
  // configured the enhancement API returns ok:false and the client falls back.
  const llmSvc = typeof ctx.get === 'function' ? ctx.get('llm') : undefined

  // Global prompt guidance: make every preset proactively discover and use
  // skills. Registered through the host systemPrompt registry so it applies to
  // all sessions (not only the make-skill preset) without overriding presets.
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  const enableGlobalGuidance = config.enableGlobalSkillGuidance !== false
  if (enableGlobalGuidance && systemPrompt && typeof systemPrompt.section === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => systemPrompt.section({
      name: 'skill-forge:use-skills',
      order: 500,
      interpolate: false,
      text: [
        'Skill usage (Skill Forge):',
        '- A catalog of available skills may be present in the conversation. Read it before acting on a task.',
        '- If a listed skill matches the user\'s request, load it with the `skill` tool BEFORE doing the work, and follow its instructions. Do not guess a skill\'s contents from its one-line summary.',
        '- Choose the most relevant skill(s) from the request intent; if none match, proceed normally.',
        '- When several skills apply, load them all up front. Follow any in-skill references only as needed.',
        '- Do not claim you used a skill unless you actually loaded it.',
      ].join('\n'),
    }), 'skill-forge: global skill-usage guidance')
  }

  const handle = async (req, res) => {
    let payload
    try {
      const url = String(req.url || '')
      const qIndex = url.indexOf('?')
      const pathname = qIndex >= 0 ? url.slice(0, qIndex) : url
      const query = new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : '')

      if (req.method === 'GET') {
        const name = query.get('name')
        const source = query.get('source') || undefined
        if (name) {
          // full body for one skill
          if (!NAME_RE.test(name)) return send(res, 400, { ok: false, error: 'invalid skill name' })
          const hit = findSkillFile(config, name, source)
          if (!hit) {
            // Bundled/runtime skills have no writable file. Try the registry's
            // loader; if it cannot expose a body, return a friendly note instead
            // of a 404 so the panel never shows a raw "skill not found".
            let def
            let loadError
            if (skillsSvc && typeof skillsSvc.get === 'function') {
              try {
                def = await skillsSvc.get(name, { cwd: homeInfo(config).cwd })
              } catch (error) {
                loadError = error instanceof Error ? error.message : String(error)
              }
            }
            if (def && typeof def.content === 'string') {
              return send(res, 200, {
                ok: true,
                skill: {
                  name,
                  source: def.source || source,
                  path: def.path || '',
                  frontmatter: def.metadata || {},
                  content: def.content,
                  raw: def.content,
                  managed: false,
                },
              })
            }
            return send(res, 200, {
              ok: true,
              skill: {
                name,
                source: source || 'bundled',
                path: '',
                frontmatter: {},
                content: '（此技能为 DSH 内置/运行时技能，正文本面板无法读取。\n在会话中使用 /' + name + ' 或让模型通过 skill 工具加载即可查看其完整指令。）',
                raw: '',
                managed: false,
                unavailable: true,
                detail: loadError,
              },
            })
          }
          const text = fs.readFileSync(hit.file, 'utf8')
          const parsed = parseFrontmatter(text)
          return send(res, 200, {
            ok: true,
            skill: {
              name,
              source,
              path: hit.file,
              frontmatter: parsed.frontmatter,
              content: parsed.body,
              raw: text,
              managed: true,
            },
          })
        }
        return send(res, 200, { ok: true, ...(await listSkills(config, skillsSvc)) })
      }

      if (req.method === 'POST') {
        payload = await readJsonBody(req)
        const op = payload.op || 'list'
        switch (op) {
          case 'list': {
            return send(res, 200, { ok: true, ...(await listSkills(config, skillsSvc)) })
          }
          case 'enhancePrompt': {
            // Enhance a skill-creation prompt with an available local/configured
            // model. If none works, return ok:false and the client keeps the
            // original prompt unchanged.
            const topic = String(payload.topic || '').trim()
            const prompt = String(payload.prompt || '').trim()
            if (!topic && !prompt) return send(res, 400, { ok: false, error: '缺少输入内容' })
            const llmReady = !!(llmSvc && typeof llmSvc.stream === 'function')
            let providerCount = -1
            if (llmReady && typeof llmSvc.listProviders === 'function') {
              try { providerCount = (llmSvc.listProviders() || []).length } catch (e) { providerCount = -1 }
            }
            const diag = { llmReady, providerCount }
            const enhanced = await enhancePromptText(topic || prompt, prompt, () => llmSvc, diag)
            if (!enhanced) {
              return send(res, 200, {
                ok: false,
                error: 'no usable model',
                diag,
                prompt: prompt || topic,
              })
            }
            return send(res, 200, { ok: true, prompt: enhanced })
          }
          case 'searchGithub': {
            // Search GitHub repositories for skills matching the keyword. Uses the
            // public REST API; a token is optional (raises the rate limit).
            const q = String(payload.query || payload.q || '').trim()
            if (!q) return send(res, 400, { ok: false, error: '缺少搜索关键词' })
            const token = payload.token || config.githubToken || process.env.GITHUB_TOKEN || ''
            const headers = {
              Accept: 'application/vnd.github+json',
              'User-Agent': 'dsh-skill-forge',
              'X-GitHub-Api-Version': '2022-11-28',
            }
            if (token) headers.Authorization = 'Bearer ' + token
            // Bias results toward skill-shaped repos.
            const searchQuery = /skill/i.test(q) ? q : (q + ' skill claude')
            const url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(searchQuery)
              + '&sort=stars&order=desc&per_page=12'
            try {
              const { status, json: data } = await fetchGithubJson(url, headers, webSvc)
              if (status < 200 || status >= 300) {
                const detail = status === 403
                  ? 'GitHub API 速率受限，请稍后再试或配置 GITHUB_TOKEN。'
                  : ('GitHub 搜索失败：HTTP ' + status)
                return send(res, 200, { ok: false, error: detail, items: [] })
              }
              const items = (data.items || []).map(repo => ({
                fullName: repo.full_name,
                name: repo.name,
                description: repo.description || '',
                htmlUrl: repo.html_url,
                cloneUrl: repo.clone_url,
                stars: repo.stargazers_count || 0,
                language: repo.language || '',
                updatedAt: repo.updated_at || '',
              }))
              return send(res, 200, { ok: true, items, totalCount: data.total_count || 0, query: q })
            } catch (error) {
              return send(res, 200, {
                ok: false,
                error: '无法连接 GitHub：' + (error instanceof Error ? error.message : String(error)),
                items: [],
              })
            }
          }
          case 'setEnabled': {
            const { name, source, enabled } = payload
            if (!NAME_RE.test(String(name || ''))) return send(res, 400, { ok: false, error: 'invalid name' })
            const hit = findSkillFile(config, name, source)
            if (!hit) return send(res, 404, { ok: false, error: 'skill not found' })
            if (!isInside(hit.root.dir, hit.file)) throw new Error('path outside skill root')
            const text = fs.readFileSync(hit.file, 'utf8')
            if (!/^---\r?\n/.test(text)) throw new Error('skill has no frontmatter; cannot toggle')
            // DSH honours `disable-model-invocation: true` to exclude a skill from
            // the model catalog; `enabled:false` sets that key, `true` clears it.
            const next = patchFrontmatterKey(text, 'disable-model-invocation', enabled ? 'false' : 'true')
            fs.writeFileSync(hit.file, next, 'utf8')
            return send(res, 200, { ok: true })
          }
          case 'delete': {
            const { name, source } = payload
            if (!NAME_RE.test(String(name || ''))) return send(res, 400, { ok: false, error: 'invalid name' })
            const hit = findSkillFile(config, name, source)
            if (!hit) return send(res, 404, { ok: false, error: 'skill not found' })
            if (!isInside(hit.root.dir, hit.file)) throw new Error('path outside skill root')
            if (hit.file.endsWith('SKILL.md')) {
              fs.rmSync(path.dirname(hit.file), { recursive: true, force: true })
            } else {
              fs.unlinkSync(hit.file)
            }
            return send(res, 200, { ok: true })
          }
          case 'create': {
            const { name, description, source, content } = payload
            if (!NAME_RE.test(String(name || ''))) return send(res, 400, { ok: false, error: '名称须为小写字母、数字与连字符' })
            const roots = skillRoots(homeInfo(config))
            const root = (source && roots.find(r => r.id === source)) || roots.find(r => r.id === 'user-dsh') || roots[0]
            if (!root) throw new Error('no writable skill root')
            try {
              fs.mkdirSync(root.dir, { recursive: true })
            } catch (error) {
              throw new Error('无法创建目录：' + error.message)
            }
            const dir = path.join(root.dir, name)
            const file = path.join(dir, 'SKILL.md')
            if (fs.existsSync(dir) || fs.existsSync(path.join(root.dir, name + '.md'))) {
              return send(res, 409, { ok: false, error: '同名 skill 已存在' })
            }
            fs.mkdirSync(dir, { recursive: true })
            const fm = { name, description: String(description || name), 'user-invocable': 'true' }
            const body = typeof content === 'string' && content.trim()
              ? content.trim()
              : `# ${name}\n\n在此编写 skill 的指令正文。\n`
            fs.writeFileSync(file, serializeFrontmatter(fm, body), 'utf8')
            return send(res, 200, { ok: true, path: file })
          }
          default:
            return send(res, 400, { ok: false, error: 'unknown op: ' + op })
        }
      }

      return send(res, 405, { ok: false, error: 'method not allowed' })
    } catch (error) {
      ctx.logger?.warn?.('[dsh-skill-forge] api error:', error)
      return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const dispose = webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: handle,
  })
  if (typeof dispose === 'function') ctx.effect(() => dispose)
  ctx.logger?.info?.('[dsh-skill-forge] management API mounted at ' + ROUTE)
}
