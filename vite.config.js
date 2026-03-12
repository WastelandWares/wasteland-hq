import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import fs from 'fs'
import path from 'path'
import { join } from 'path'
import { execSync } from 'child_process'
import { GITEA_URL, GITEA_ORG, REPO_NAMES } from './src/config/repos.js'

const STATUS_PATH = path.join(process.env.HOME, '.claude', 'hq-status.json')
const PINBOARD_PATH = path.join(process.env.HOME, '.claude', 'pinboard.json')

function getGiteaToken() {
  try {
    return process.env.GITEA_TOKEN || readFileSync(
      join(process.env.HOME, '.claude', '.gitea-token'), 'utf-8'
    ).trim()
  } catch {
    return ''
  }
}

function giteaIssuesPlugin() {
  return {
    name: 'gitea-issues-proxy',
    configureServer(server) {
      server.middlewares.use('/api/issues', async (req, res) => {
        const token = getGiteaToken()
        const headers = {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `token ${token}` } : {}),
        }

        try {
          const allIssues = []
          for (const repo of REPO_NAMES) {
            try {
              const url = `${GITEA_URL}/api/v1/repos/${GITEA_ORG}/${repo}/issues?state=open&type=issues&limit=50`
              const response = await fetch(url, { headers })
              if (response.ok) {
                const issues = await response.json()
                allIssues.push(
                  ...issues.map((issue) => ({
                    id: issue.id,
                    number: issue.number,
                    title: issue.title,
                    body: issue.body || '',
                    state: issue.state,
                    repo: repo,
                    url: `${GITEA_URL}/${GITEA_ORG}/${repo}/issues/${issue.number}`,
                    labels: (issue.labels || []).map((l) => ({
                      name: l.name,
                      color: l.color,
                    })),
                    assignees: (issue.assignees || []).map((a) => a.login),
                    milestone: issue.milestone?.title || null,
                    created_at: issue.created_at,
                    updated_at: issue.updated_at,
                    pull_request: issue.pull_request || null,
                  }))
                )
              }
            } catch {
              // Skip repos that fail (might not exist)
            }
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
        const token = getGiteaToken()
        const headers = {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `token ${token}` } : {}),
        }

        try {
          const openIssues = []
          const closedIssues = []
          const STALE_DAYS = 7
          const RECENTLY_CLOSED_HOURS = 48
          const now = Date.now()

          for (const repo of REPO_NAMES) {
            try {
              // Fetch open issues
              const openUrl = `${GITEA_URL}/api/v1/repos/${GITEA_ORG}/${repo}/issues?state=open&type=issues&limit=50`
              const openRes = await fetch(openUrl, { headers })
              if (openRes.ok) {
                const issues = await openRes.json()
                openIssues.push(...issues.map(i => ({ ...i, repo })))
              }

              // Fetch recently closed issues (sorted by updated_at desc)
              const closedUrl = `${GITEA_URL}/api/v1/repos/${GITEA_ORG}/${repo}/issues?state=closed&type=issues&limit=20&sort=updated&direction=desc`
              const closedRes = await fetch(closedUrl, { headers })
              if (closedRes.ok) {
                const issues = await closedRes.json()
                closedIssues.push(...issues.map(i => ({ ...i, repo })))
              }
            } catch {
              // Skip repos that fail
            }
          }

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
            const closedAt = new Date(i.closed_at || i.updated_at).getTime()
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), hqApiPlugin(), giteaIssuesPlugin(), issueStatsPlugin()],
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
