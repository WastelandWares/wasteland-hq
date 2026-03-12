/**
 * Single source of truth for all tracked repositories.
 *
 * Every component that needs the repo list, colors, or org info
 * should import from here instead of maintaining its own copy.
 *
 * To add a new repo: add an entry to REPOS below. That's it.
 */

export const GITHUB_URL = 'https://api.github.com'
export const GITHUB_ORG = 'severeon'

/**
 * Tracked repositories with display metadata.
 * @type {Array<{ name: string, color: string }>}
 */
export const REPOS = [
  { name: 'dungeon-crawler',        color: '#00e88f' },
  { name: 'wasteland-infra',        color: '#4ea8ff' },
  { name: 'claude-gate',            color: '#a78bfa' },
  { name: 'wasteland-hq',           color: '#22d3ee' },
  { name: 'dnd-tools',              color: '#ffc857' },
  { name: 'meeting-scribe',         color: '#fb923c' },
  { name: 'wasteland-orchestrator', color: '#ff5c5c' },
  { name: 'neuroscript-rs',         color: '#e879f9' },
]

/** Repo names as a flat array (for iteration in API calls, etc.) */
export const REPO_NAMES = REPOS.map(r => r.name)

/** Map of repo name → display color */
export const REPO_COLORS = Object.fromEntries(
  REPOS.map(r => [r.name, r.color])
)

/** Map of repo name → dimmed color (for backgrounds) */
export const REPO_COLORS_DIM = Object.fromEntries(
  REPOS.map(r => [r.name, r.color + '30'])
)
