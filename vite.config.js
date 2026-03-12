import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { GITHUB_URL, GITHUB_ORG, REPO_NAMES } from './src/config/repos.js'

const STATUS_PATH = path.join(process.env.HOME, '.claude', 'hq-status.json')
const PINBOARD_PATH = path.join(process.env.HOME, '.claude', 'pinboard.json')
const SUMMARIES_DIR = path.join(process.env.HOME, '.claude', 'daily-summaries')
const BRIEFINGS_DIR = path.join(process.env.HOME, '.claude', 'briefings')

// Cache for GitHub API responses (2-minute TTL)
let githubApiCache = {}
const CACHE_TTL = 2 * 60 * 1000 // 2 minutes

function getCachedGitHubData(cacheKey) {
  const cached = githubApiCache[cacheKey]
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data
  }
  return null
}

function setCachedGitHubData(cacheKey, data) {
  githubApiCache[cacheKey] = { data, timestamp: Date.now() }
}

function getGitHubToken() {
  try {
    // Prefer env var, fall back to gh CLI auth
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
    return execSync('gh auth token', { encoding: 'utf-8', timeout: 5000 }).trim()
  } catch {
    return ''
  }
}

function githubIssuesPlugin() {
  return {
    name: 'github-issues-proxy',
    configureServer(server) {
      server.middlewares.use('/api/issues', async (req, res) => {
        const token = getGitHubToken()
        const headers = {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'wasteland-hq',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        }

        try {
          // Try to get open issues from cache first
          const cacheKey = 'open-issues'
          let allIssues = getCachedGitHubData(cacheKey)

          if (!allIssues) {
            allIssues = []
            const results = await Promise.all(
              REPO_NAMES.map(async (repo) => {
                try {
                  const url = `${GITHUB_URL}/repos/${GITHUB_ORG}/${repo}/issues?state=open&per_page=100`
                  const response = await fetch(url, { headers })
                  if (response.ok) {
                    const issues = await response.json()
                    return issues
                      .filter((issue) => !issue.pull_request)
                      .map((issue) => ({
                        id: issue.id,
                        number: issue.number,
                        title: issue.title,
                        body: issue.body || '',
                        state: issue.state,
                        repo: repo,
                        url: issue.html_url,
                        labels: (issue.labels || []).map((l) => ({
                          name: l.name,
                          color: l.color,
                        })),
                        assignees: (issue.assignees || []).map((a) => a.login),
                        milestone: issue.milestone?.title || null,
                        created_at: issue.created_at,
                        updated_at: issue.updated_at,
                      }))
                  }
                } catch {
                  // Skip repos that fail (might not exist)
                }
                return []
              })
            )
            allIssues.push(...results.flat())
            setCachedGitHubData(cacheKey, allIssues)
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ issues: allIssues, timestamp: new Date().toISOString() }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
    },
  }
}

function issueStatsPlugin() {
  return {
    name: 'issue-stats-proxy',
    configureServer(server) {
      server.middlewares.use('/api/issue-stats', async (req, res) => {
        const token = getGitHubToken()
        const headers = {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'wasteland-hq',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        }

        try {
          const STALE_DAYS = 7
          const RECENTLY_CLOSED_HOURS = 48
          const now = Date.now()

          // Get open issues from cache (shared with githubIssuesPlugin)
          let cachedOpenIssues = getCachedGitHubData('open-issues')
          let openIssues = []

          if (cachedOpenIssues) {
            // Transform cached data to format expected by stats
            openIssues = cachedOpenIssues.map(i => ({
              ...i,
              repo: i.repo,
              updated_at: i.updated_at,
            }))
          } else {
            // Fallback: fetch open issues if not in cache
            const results = await Promise.all(
              REPO_NAMES.map(async (repo) => {
                try {
                  const openUrl = `${GITHUB_URL}/repos/${GITHUB_ORG}/${repo}/issues?state=open&per_page=100`
                  const openRes = await fetch(openUrl, { headers })
                  if (openRes.ok) {
                    const issues = await openRes.json()
                    return issues.filter(i => !i.pull_request).map(i => ({ ...i, repo }))
                  }
                } catch {
                  // Skip repos that fail
                }
                return []
              })
            )
            openIssues.push(...results.flat())
            setCachedGitHubData('open-issues', openIssues)
          }

          // Fetch recently closed issues (not cached, always fresh)
          const closedResults = await Promise.all(
            REPO_NAMES.map(async (repo) => {
              try {
                const closedUrl = `${GITHUB_URL}/repos/${GITHUB_ORG}/${repo}/issues?state=closed&per_page=20&sort=updated&direction=desc`
                const closedRes = await fetch(closedUrl, { headers })
                if (closedRes.ok) {
                  const issues = await closedRes.json()
                  return issues.filter(i => !i.pull_request).map(i => ({ ...i, repo }))
                }
              } catch {
                // Skip repos that fail
              }
              return []
            })
          )
          const closedIssues = closedResults.flat()

          // Compute stats
          const totalOpen = openIssues.length

          // In-progress: has tier:now, in-progress label, or sprint-related label
          const inProgress = openIssues.filter(i => {
            const labels = (i.labels || []).map(l => l.name.toLowerCase())
            return labels.includes('in-progress') ||
                   labels.includes('tier:now') ||
                   labels.some(l => l.includes('sprint'))
          }).length

          // Stalled: in-progress/tier:now but no update in STALE_DAYS
          const staleThreshold = now - (STALE_DAYS * 24 * 60 * 60 * 1000)
          const stalled = openIssues.filter(i => {
            const labels = (i.labels || []).map(l => l.name.toLowerCase())
            const isActive = labels.includes('in-progress') ||
                             labels.includes('tier:now') ||
                             labels.some(l => l.includes('sprint'))
            const lastUpdate = new Date(i.updated_at).getTime()
            return isActive && lastUpdate < staleThreshold
          }).length

          // Recently closed: closed within RECENTLY_CLOSED_HOURS
          const closedThreshold = now - (RECENTLY_CLOSED_HOURS * 60 * 60 * 1000)
          const recentlyClosed = closedIssues.filter(i => {
            if (!i.closed_at) return false
            const closedAt = new Date(i.closed_at).getTime()
            return closedAt >= closedThreshold
          }).length

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            open: totalOpen,
            inProgress,
            stalled,
            recentlyClosed,
            timestamp: new Date().toISOString(),
          }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
    },
  }
}

function hqApiPlugin() {
  return {
    name: 'hq-api',
    configureServer(server) {
      // Serve /status.json from ~/.claude/hq-status.json
      server.middlewares.use('/status.json', (req, res) => {
        try {
          const content = fs.readFileSync(STATUS_PATH, 'utf-8')
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-cache, no-store')
          res.end(content)
        } catch (e) {
          res.statusCode = 404
          res.end('{}')
        }
      })

      // POST /api/pin-verify — run a pin's verify command
      server.middlewares.use('/api/pin-verify', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'POST only' }))
          return
        }

        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try {
            const { pinId } = JSON.parse(body)
            if (!pinId) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'pinId required' }))
              return
            }

            const board = JSON.parse(fs.readFileSync(PINBOARD_PATH, 'utf-8'))
            const pin = board.notes.find(n => n.id === pinId)

            if (!pin) {
              res.statusCode = 404
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Pin not found' }))
              return
            }

            if (!pin.verify) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Pin has no verify command' }))
              return
            }

            let stdout = ''
            let stderr = ''
            let passed = false

            try {
              stdout = execSync(pin.verify, {
                timeout: 30000,
                encoding: 'utf-8',
                shell: '/bin/bash',
                env: { ...process.env, PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin' },
              }).trim()
              passed = true
            } catch (execErr) {
              stdout = (execErr.stdout || '').trim()
              stderr = (execErr.stderr || '').trim()
              passed = false
            }

            const now = new Date().toISOString()

            if (passed) {
              pin.done = true
              pin.completed_at = now
              pin.completed_by = 'dashboard-verify'
              pin.verify_result = { passed: true, output: stdout, verified_at: now }
            } else {
              pin.verify_result = {
                passed: false,
                output: stdout,
                error: stderr,
                verified_at: now,
              }
            }

            board.last_updated = now
            board.last_updated_by = 'dashboard-verify'

            const tmp = PINBOARD_PATH + '.tmp'
            fs.writeFileSync(tmp, JSON.stringify(board, null, 2))
            fs.renameSync(tmp, PINBOARD_PATH)

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              passed,
              output: stdout,
              error: stderr || undefined,
              pin: { id: pin.id, done: pin.done },
            }))

          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: e.message }))
          }
        })
      })
    },
  }
}

function dailyLogPlugin() {
  return {
    name: 'daily-log-api',
    configureServer(server) {
      // GET /api/daily-log — list available daily summaries
      server.middlewares.use('/api/daily-log', (req, res, next) => {
        const url = new URL(req.url, 'http://localhost')

        // Match /api/daily-log/YYYY-MM-DD for specific date
        const dateMatch = url.pathname.match(/(\d{4}-\d{2}-\d{2})$/)
        if (dateMatch) {
          const date = dateMatch[1]
          return serveDailySummary(date, res)
        }

        // /api/daily-log — list all entries
        if (url.pathname === '/') {
          return serveDailyList(res)
        }

        next()
      })
    },
  }
}

function serveDailyList(res) {
  try {
    const entries = []

    if (fs.existsSync(SUMMARIES_DIR)) {
      const files = fs.readdirSync(SUMMARIES_DIR)
        .filter(f => f.endsWith('.json') && /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
        .reverse()
        .slice(0, 30)

      for (const file of files) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(SUMMARIES_DIR, file), 'utf-8'))
          entries.push(content)
        } catch {
          // Skip malformed files
        }
      }
    }

    // If no summaries, try to create entries from briefing files
    if (entries.length === 0 && fs.existsSync(BRIEFINGS_DIR)) {
      const briefings = fs.readdirSync(BRIEFINGS_DIR)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 14)

      for (const file of briefings) {
        const date = file.replace('.md', '')
        const briefingPath = path.join(BRIEFINGS_DIR, file)
        try {
          const content = fs.readFileSync(briefingPath, 'utf-8')
          // Extract a summary from the briefing
          const entry = parseBriefingToSummary(date, content)
          if (entry) entries.push(entry)
        } catch {
          // Skip
        }
      }
    }

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-cache')
    res.end(JSON.stringify({ entries, timestamp: new Date().toISOString() }))
  } catch (e) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: e.message }))
  }
}

function serveDailySummary(date, res) {
  // Try summary file first
  const summaryPath = path.join(SUMMARIES_DIR, `${date}.json`)
  if (fs.existsSync(summaryPath)) {
    try {
      const content = fs.readFileSync(summaryPath, 'utf-8')
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-cache')
      res.end(content)
      return
    } catch {
      // Fall through
    }
  }

  // Fallback to briefing file
  const briefingPath = path.join(BRIEFINGS_DIR, `${date}.md`)
  if (fs.existsSync(briefingPath)) {
    try {
      const content = fs.readFileSync(briefingPath, 'utf-8')
      const entry = parseBriefingToSummary(date, content)
      if (entry) {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(JSON.stringify(entry))
        return
      }
    } catch {
      // Fall through
    }
  }

  res.statusCode = 404
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: `No summary found for ${date}` }))
}

function parseBriefingToSummary(date, markdown) {
  const lines = markdown.split('\n')

  let prose = ''
  let inSummary = false
  for (const line of lines) {
    if (line.includes('Executive Summary')) { inSummary = true; continue }
    if (inSummary) {
      if (line.startsWith('---')) break
      if (line.trim()) prose += (prose ? ' ' : '') + line.trim()
    }
  }

  const highlights = []
  let inProject = false
  for (const line of lines) {
    if (line.startsWith('### ') && !line.includes('Raw') && !line.includes('Sync')) { inProject = true; continue }
    if (inProject && line.startsWith('---')) { inProject = false; continue }
    if (inProject && line.startsWith('- ') && highlights.length < 10) highlights.push(line.slice(2).trim())
  }

  const open_issues = {}
  let inIssues = false
  let currentRepo = null
  for (const line of lines) {
    if (line.includes('Open Issues')) {
      inIssues = true
      continue
    }
    if (inIssues && line.startsWith('---')) break
    if (inIssues) {
      const repoMatch = line.match(/^\*\*([^*]+)\*\*\s*\((\d+)\s+open\)/)
      if (repoMatch) {
        currentRepo = repoMatch[1]
        open_issues[currentRepo] = { count: parseInt(repoMatch[2]), notable: [] }
        continue
      }
      if (currentRepo && line.startsWith('- #')) {
        open_issues[currentRepo].notable.push(line.slice(2).trim())
      }
    }
  }

  // Extract metadata
  const genMatch = markdown.match(/Generated:\s*(.+)/)
  const sessMatch = markdown.match(/Sessions:\s*(\d+)/)

  if (!prose && highlights.length === 0) return null

  // Truncate prose for card preview
  if (prose.length > 300) {
    prose = prose.slice(0, 297) + '...'
  }

  return {
    date,
    generated_at: genMatch ? genMatch[1] : null,
    prose: prose || 'No executive summary available for this date.',
    highlights,
    open_issues,
    notes: [],
    metrics: {
      commits: 0,
      prs_merged: 0,
      issues_created: 0,
      issues_closed: 0,
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), hqApiPlugin(), githubIssuesPlugin(), issueStatsPlugin(), dailyLogPlugin()],
  server: {
    host: '0.0.0.0',
    hmr: {
      host: '0.0.0.0',
      clientPort: 5173,
    },
    watch: {
      ignored: ['**/public/status.json', '**/public/status.json.tmp'],
    },
  },
})
