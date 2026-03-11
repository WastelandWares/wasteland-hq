import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const STATUS_PATH = path.join(process.env.HOME, '.claude', 'hq-status.json')
const PINBOARD_PATH = path.join(process.env.HOME, '.claude', 'pinboard.json')

const GITEA_URL = 'http://localhost:3003'
const GITEA_ORG = 'tquick'
// Each entry is either 'repo' (uses GITEA_ORG) or 'org/repo' (explicit org)
const REPOS = [
  'dungeon-crawler',
  'wasteland-infra',
  'claude-gate',
  'wasteland-hq',
  'dnd-tools',
  'meeting-scribe',
  'wasteland-orchestrator',
  'severeon/neuroscript-rs',
]

function repoFullPath(entry) {
  return entry.includes('/') ? entry : `${GITEA_ORG}/${entry}`
}

function repoName(entry) {
  return entry.includes('/') ? entry.split('/').pop() : entry
}

function getGiteaToken() {
  try {
    return process.env.GITEA_TOKEN || readFileSync(
      path.join(process.env.HOME, '.claude', '.gitea-token'), 'utf-8'
    ).trim()
  } catch {
    return ''
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
          for (const entry of REPOS) {
            try {
              const fullPath = repoFullPath(entry)
              const name = repoName(entry)
              const url = `${GITEA_URL}/api/v1/repos/${fullPath}/issues?state=open&type=issues&limit=50`
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
                    repo: name,
                    url: `${GITEA_URL}/${fullPath}/issues/${issue.number}`,
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
              // Skip repos that fail
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), hqApiPlugin(), giteaIssuesPlugin()],
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
