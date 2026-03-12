import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { join } from 'path'

const GITEA_URL = 'http://localhost:3003'
const GITEA_ORG = 'tquick'
const REPOS = [
  'dungeon-crawler',
  'wasteland-infra',
  'claude-gate',
  'wasteland-hq',
  'dnd-tools',
  'meeting-scribe',
  'wasteland-orchestrator',
]

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
          for (const repo of REPOS) {
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

          for (const repo of REPOS) {
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), giteaIssuesPlugin(), issueStatsPlugin()],
})
