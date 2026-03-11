import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { dbg, dbgDiff, startDomObserver, trackRender } from './debug'
import './App.css'
import TechTree from './TechTree.jsx'

const STATE_COLORS = {
  working: 'var(--green)',
  idle: 'var(--text-dim)',
  reviewing: 'var(--purple)',
  brainstorming: 'var(--yellow)',
  blocked: 'var(--red)',
  meeting: 'var(--purple)',
  starting: 'var(--blue)',
  stopping: 'var(--text-dim)',
  cooking: 'var(--orange)',
}

const COLOR_MAP = {
  red: 'var(--red)',
  yellow: 'var(--yellow)',
  green: 'var(--green)',
  blue: 'var(--blue)',
  purple: 'var(--purple)',
  cyan: 'var(--cyan)',
  orange: 'var(--orange)',
}

const PRI_ICONS = { high: '\u2757', medium: '\u2013', low: '\u00B7' }
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 }

/* ────────────────────────────────────────────────────────
 * useStatus — fetches /status.json on interval
 * Stabilizes pinboard/agents/projects references via
 * JSON comparison so downstream memos work correctly.
 * ──────────────────────────────────────────────────────── */
function useStatus(interval = 3000) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const prevJsonRef = useRef('')
  const bestKnownRef = useRef({})

  useEffect(() => {
    let active = true
    dbg('lifecycle', `useStatus effect MOUNT (interval=${interval})`)

    const fetchStatus = async () => {
      try {
        const url = '/status.json?' + Date.now()
        dbg('fetch', `fetching ${url}`)
        const res = await fetch(url)
        dbg('fetch', `response: ${res.status} ${res.statusText}`)

        if (!res.ok) {
          dbg('fetch', `!res.ok — skipping setData`)
          return
        }

        const text = await res.text()
        dbg('fetch', `body length: ${text.length} chars`)

        if (!active) {
          dbg('fetch', `effect no longer active — discarding`)
          return
        }

        const parsed = JSON.parse(text)
        dbg('data', `parsed: ${parsed.agents?.length} agents, ${parsed.projects?.length} projects, ${parsed.pinboard?.length} pinboard`)

        // ── Merge with best-known data ──
        // If the new response is MISSING a field that we previously had,
        // preserve the last-known-good value. This handles the case where
        // an older status writer (without pinboard support) alternates
        // with the current one.
        const best = bestKnownRef.current
        const merged = { ...parsed }

        if (parsed.pinboard && parsed.pinboard.length > 0) {
          best.pinboard = parsed.pinboard
          dbg('data', `pinboard: updated best-known (${parsed.pinboard.length} items)`)
        } else if (best.pinboard) {
          merged.pinboard = best.pinboard
          dbg('data', `pinboard: MISSING from response — using best-known (${best.pinboard.length} items)`)
        }

        if (parsed.projects && parsed.projects.length > (best.projects?.length || 0)) {
          best.projects = parsed.projects
        }
        if (best.projects && (!parsed.projects || parsed.projects.length < best.projects.length)) {
          merged.projects = best.projects
          dbg('data', `projects: using best-known (${best.projects.length} vs ${parsed.projects?.length})`)
        }

        // Deduplicate: only update state if the MERGED result differs
        const mergedJson = JSON.stringify(merged)
        if (mergedJson === prevJsonRef.current) {
          dbg('fetch', `merged JSON unchanged — skipping setData`)
          return
        }

        dbg('fetch', `merged JSON CHANGED — updating state`)
        prevJsonRef.current = mergedJson

        setData(merged)
        setError(null)
      } catch (e) {
        dbg('fetch', `ERROR: ${e.message}`)
        if (active) setError(e.message)
      }
    }

    fetchStatus()
    const id = setInterval(fetchStatus, interval)

    return () => {
      dbg('lifecycle', `useStatus effect CLEANUP`)
      active = false
      clearInterval(id)
    }
  }, [interval])

  return { data, error }
}

/* ── Clock — self-contained, doesn't trigger parent re-renders ── */
function Clock() {
  const [time, setTime] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="clock">
      {time.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      })}
    </div>
  )
}

function getLeadAgent(agents) {
  const pm = agents?.find(a => a.agent === 'pm')
  if (pm) return pm
  const working = agents?.find(a => a.state === 'working' && a.alive)
  if (working) return working
  return agents?.[0] || { state: 'idle', task: 'No agents running' }
}

function StatusBeacon({ state }) {
  return (
    <div className={`status-beacon ${state}`}>
      <div className="core" />
      <div className="ring" />
      <div className="ring ring-outer" />
    </div>
  )
}

function AgentCard({ agent }) {
  const isStale = agent.stale && !agent.alive
  const state = isStale ? 'stale' : (agent.state || 'idle')
  const repo = agent.repo?.split('/')?.pop() || ''
  const ref = agent.issue ? `${repo}#${agent.issue}` : repo

  return (
    <div className={`agent-card ${state}`}>
      <div className="agent-header">
        <div className="agent-dot" />
        <span className="agent-name">{agent.agent}</span>
      </div>
      <div className="agent-task">
        {isStale ? 'Stale — no heartbeat' : (agent.task || 'Idle')}
      </div>
      {ref && <div className="agent-ref">{ref}</div>}
    </div>
  )
}

function ProjectRow({ project, maxIssues }) {
  const totalPct = maxIssues > 0 ? (project.open / maxIssues) * 100 : 0
  const sprintPct = maxIssues > 0 ? (project.sprint / maxIssues) * 100 : 0

  return (
    <div className="project-row">
      <div className="project-name">{project.name}</div>
      <div className="project-bar-container">
        <div className="project-bar total" style={{ width: `${totalPct}%` }} />
        <div className="project-bar sprint" style={{ width: `${sprintPct}%` }} />
      </div>
      <div className="project-counts">
        <span className="count-open">{project.open} open</span>
        {project.sprint > 0 && (
          <span className="count-sprint">{project.sprint} sprint</span>
        )}
      </div>
    </div>
  )
}

/* ── PinCard ── */
const PinCard = memo(function PinCard({ note }) {
  const [expanded, setExpanded] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState(note.verify_result || null)
  const renderCount = trackRender(`PinCard:${note.id}`)

  useEffect(() => {
    dbg('lifecycle', `PinCard MOUNT: ${note.id} "${note.text.slice(0, 40)}"`)
    return () => {
      dbg('lifecycle', `PinCard UNMOUNT: ${note.id} "${note.text.slice(0, 40)}"`)
    }
  }, [note.id, note.text])

  // Sync verify_result from props if it changes externally
  useEffect(() => {
    if (note.verify_result) setVerifyResult(note.verify_result)
  }, [note.verify_result])

  const hasDetails = note.details || (note.links && note.links.length > 0) || note.issue || note.code || note.verify
  const hasExpandable = hasDetails || note.created_at

  const open = useCallback((e) => {
    e.stopPropagation()
    if (hasExpandable && !expanded) {
      dbg('state', `PinCard ${note.id} expanded: true`)
      setExpanded(true)
    }
  }, [hasExpandable, expanded, note.id])

  const close = useCallback((e) => {
    e.stopPropagation()
    dbg('state', `PinCard ${note.id} expanded: false`)
    setExpanded(false)
  }, [note.id])

  const runVerify = useCallback(async (e) => {
    e.stopPropagation()
    if (verifying) return
    setVerifying(true)
    setVerifyResult(null)
    dbg('fetch', `pin-verify: running for ${note.id}`)
    try {
      const res = await fetch('/api/pin-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinId: note.id }),
      })
      const result = await res.json()
      dbg('data', `pin-verify result for ${note.id}:`, result)
      setVerifyResult({
        passed: result.passed,
        output: result.output,
        error: result.error,
        verified_at: new Date().toISOString(),
      })
    } catch (err) {
      dbg('fetch', `pin-verify ERROR: ${err.message}`)
      setVerifyResult({ passed: false, error: err.message, verified_at: new Date().toISOString() })
    } finally {
      setVerifying(false)
    }
  }, [note.id, verifying])

  const issueUrl = note.issue ? (() => {
    const match = note.issue.match(/^([^#]+)#(\d+)$/)
    if (!match) return null
    const [, repo, num] = match
    return `https://git.wastelandwares.com/tquick/${repo}/issues/${num}`
  })() : null

  const age = note.created_at ? (() => {
    const ms = Date.now() - new Date(note.created_at).getTime()
    const hrs = Math.floor(ms / 3600000)
    if (hrs < 1) return 'just now'
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    return `${days}d ago`
  })() : null

  return (
    <div
      className={`pin-card ${note.done ? 'done' : ''} ${hasExpandable ? 'clickable' : ''} ${expanded ? 'expanded' : ''}`}
      style={{ '--pin-color': COLOR_MAP[note.color] || 'var(--yellow)' }}
      onClick={expanded ? undefined : open}
      data-pin-id={note.id}
    >
      <div className="pin-header" onClick={expanded ? undefined : open}>
        <span className="pin-priority">{PRI_ICONS[note.priority] || '\u2013'}</span>
        {note.project && <span className="pin-project">{note.project}</span>}
        {note.issue && (
          <a
            className="pin-issue-badge"
            href={issueUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
          >
            {note.issue}
          </a>
        )}
        {expanded ? (
          <button className="pin-close-btn" onClick={close} title="Close">&times;</button>
        ) : hasExpandable ? (
          <span className="pin-expand-icon">{'\u25BE'}</span>
        ) : null}
      </div>
      <div className="pin-text">{note.text}</div>
      <div className="pin-meta">
        {note.created_by && <span>{note.created_by}</span>}
        {age && <span className="pin-age">{age}</span>}
      </div>

      {expanded && (
        <div className="pin-details" onClick={e => e.stopPropagation()}>
          {note.details && <div className="pin-details-text">{note.details}</div>}
          {note.code && <pre className="pin-code"><code>{note.code}</code></pre>}
          {note.links && note.links.length > 0 && (
            <div className="pin-links">
              {note.links.map((link, i) => (
                <a key={i} className="pin-link" href={link.url} target="_blank"
                  rel="noopener noreferrer">
                  {link.label || link.url}
                </a>
              ))}
            </div>
          )}

          {/* Verify & Complete button — only on pins with a verify command */}
          {note.verify && !note.done && (
            <div className="pin-verify-section">
              <div className="pin-verify-cmd">
                <span className="pin-verify-label">Test:</span>
                <code>{note.verify}</code>
              </div>
              <button
                className={`pin-verify-btn ${verifying ? 'running' : ''}`}
                onClick={runVerify}
                disabled={verifying}
              >
                {verifying ? 'Running...' : 'Verify & Complete'}
              </button>
            </div>
          )}

          {/* Verify result display */}
          {verifyResult && (
            <div className={`pin-verify-result ${verifyResult.passed ? 'passed' : 'failed'}`}>
              <div className="pin-verify-status">
                {verifyResult.passed ? 'PASSED' : 'FAILED'}
                {verifyResult.verified_at && (
                  <span className="pin-verify-time">
                    {new Date(verifyResult.verified_at).toLocaleTimeString()}
                  </span>
                )}
              </div>
              {verifyResult.output && (
                <pre className="pin-verify-output">{verifyResult.output}</pre>
              )}
              {verifyResult.error && (
                <pre className="pin-verify-output error">{verifyResult.error}</pre>
              )}
            </div>
          )}

          {note.completed_at && note.done && !verifyResult && (
            <div className="pin-completed">
              Completed {new Date(note.completed_at).toLocaleString()}
              {note.completed_by ? ` by ${note.completed_by}` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  )
}, (prev, next) => {
  const same = prev.note.id === next.note.id
    && prev.note.done === next.note.done
    && prev.note.text === next.note.text
    && prev.note.details === next.note.details
    && prev.note.code === next.note.code
    && prev.note.issue === next.note.issue
    && prev.note.verify === next.note.verify
    && prev.note.updated_at === next.note.updated_at
    && JSON.stringify(prev.note.verify_result) === JSON.stringify(next.note.verify_result)
  if (!same) {
    dbg('render', `PinCard memo: ${prev.note.id} WILL re-render (data changed)`)
  }
  return same
})

/* ── PinboardSection ── */
const PinboardSection = memo(function PinboardSection({ notes }) {
  const renderCount = trackRender('PinboardSection')
  const prevNotesRef = useRef(null)

  useEffect(() => {
    dbg('lifecycle', 'PinboardSection MOUNT')
    // Attach DOM observer after mount
    setTimeout(() => startDomObserver('.pin-grid'), 100)
    return () => dbg('lifecycle', 'PinboardSection UNMOUNT')
  }, [])

  // Log data diffs
  useEffect(() => {
    if (prevNotesRef.current !== null) {
      dbgDiff('data', 'PinboardSection notes', prevNotesRef.current, notes)
    }
    prevNotesRef.current = notes
  }, [notes])

  const safeNotes = notes || []
  const sorted = [...safeNotes].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    return (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
  })

  dbg('render', `PinboardSection render #${renderCount}: ${sorted.length} notes`)

  return (
    <div className="pinboard-section">
      <div className="section-label">Pinboard</div>
      <div className="pin-grid">
        {sorted.length === 0 ? (
          <div className="pin-empty">No pinned items</div>
        ) : (
          sorted.map(note => (
            <PinCard key={note.id} note={note} />
          ))
        )}
      </div>
    </div>
  )
}, (prev, next) => {
  if (!prev.notes && !next.notes) return true
  if (!prev.notes || !next.notes) {
    dbg('render', `PinboardSection memo: notes null mismatch — WILL re-render`)
    return false
  }
  if (prev.notes.length !== next.notes.length) {
    dbg('render', `PinboardSection memo: length changed ${prev.notes.length} → ${next.notes.length} — WILL re-render`)
    return false
  }
  if (prev.notes === next.notes) {
    // Same reference — skip
    return true
  }
  for (let i = 0; i < prev.notes.length; i++) {
    if (prev.notes[i].id !== next.notes[i].id) {
      dbg('render', `PinboardSection memo: id mismatch at [${i}] — WILL re-render`)
      return false
    }
    if (prev.notes[i].done !== next.notes[i].done) {
      dbg('render', `PinboardSection memo: done changed for ${prev.notes[i].id} — WILL re-render`)
      return false
    }
    if (prev.notes[i].text !== next.notes[i].text) {
      dbg('render', `PinboardSection memo: text changed for ${prev.notes[i].id} — WILL re-render`)
      return false
    }
    if (prev.notes[i].updated_at !== next.notes[i].updated_at) {
      dbg('render', `PinboardSection memo: updated_at changed for ${prev.notes[i].id} — WILL re-render`)
      return false
    }
  }
  return true
})

/* ── ObjectivesLog ── */
const ObjectivesLog = memo(function ObjectivesLog({ objectives, currentTask }) {
  const MAX_VISIBLE = 5
  // Show most recent first, skip if it matches current task (already shown as active)
  const history = (objectives || [])
    .filter(o => o.text !== currentTask)
    .slice(-MAX_VISIBLE)
    .reverse()

  const formatTime = (ts) => {
    if (!ts) return ''
    const d = new Date(ts)
    return d.toLocaleString('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  }

  return (
    <div className="objectives-log">
      {currentTask && (
        <div className="objective-item active">
          <span className="objective-text gradient-text">{currentTask}</span>
        </div>
      )}
      {history.map((obj, i) => (
        <div key={obj.timestamp + i} className="objective-item past">
          <span className="objective-time">[{formatTime(obj.timestamp)}]</span>
          <span className="objective-text">{obj.text}</span>
        </div>
      ))}
    </div>
  )
})

function SummaryBar({ agents, projects }) {
  const working = agents?.filter(a => a.state === 'working' && a.alive).length || 0
  const idle = agents?.filter(a => a.state === 'idle').length || 0
  const stale = agents?.filter(a => a.stale && !a.alive).length || 0
  const totalIssues = projects?.reduce((s, p) => s + p.open, 0) || 0
  const totalSprint = projects?.reduce((s, p) => s + p.sprint, 0) || 0

  return (
    <div className="summary-bar">
      <div className="summary-stat">
        <div className="dot green" />
        <span className="value">{working}</span> working
      </div>
      <div className="summary-stat">
        <div className="dot dim" />
        <span className="value">{idle}</span> idle
      </div>
      {stale > 0 && (
        <div className="summary-stat">
          <div className="dot red" />
          <span className="value">{stale}</span> stale
        </div>
      )}
      <div className="summary-stat">
        <div className="dot blue" />
        <span className="value">{totalIssues}</span> issues
      </div>
      <div className="summary-stat">
        <div className="dot green" />
        <span className="value">{totalSprint}</span> in sprint
      </div>
    </div>
  )
}

function TabBar({ activeTab, onTabChange }) {
  return (
    <div className="tab-bar">
      <button
        className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
        onClick={() => onTabChange('dashboard')}
      >
        <span className="tab-icon">◉</span>
        Dashboard
      </button>
      <button
        className={`tab-btn ${activeTab === 'techtree' ? 'active' : ''}`}
        onClick={() => onTabChange('techtree')}
      >
        <span className="tab-icon">⬡</span>
        Tech Tree
      </button>
    </div>
  )
}

export default function App() {
  const { data, error } = useStatus(3000)
  const [activeTab, setActiveTab] = useState('dashboard')
  const [showAllAgents, setShowAllAgents] = useState(() => {
    try { return localStorage.getItem('hq-show-all-agents') === 'true' } catch { return false }
  })
  const renderCount = trackRender('App')
  const prevDataRef = useRef(null)

  useEffect(() => {
    dbg('lifecycle', 'App MOUNT')
    return () => dbg('lifecycle', 'App UNMOUNT')
  }, [])

  useEffect(() => {
    if (prevDataRef.current !== null) {
      dbg('data', `App data changed (render #${renderCount})`)
      dbgDiff('data', 'agents', prevDataRef.current?.agents, data?.agents)
      dbgDiff('data', 'projects', prevDataRef.current?.projects, data?.projects)
      dbgDiff('data', 'pinboard', prevDataRef.current?.pinboard, data?.pinboard)
    } else {
      dbg('data', `App initial data: ${data ? 'received' : 'null'}`)
    }
    prevDataRef.current = data
  }, [data])

  const agents = data?.agents || []
  const projects = data?.projects || []
  const lead = getLeadAgent(agents)

  // Agent visibility: active/recent = alive OR heartbeat < 30min OR state is working/reviewing
  const RECENT_THRESHOLD = 30 * 60 // 30 minutes in seconds
  const activeAgents = agents.filter(a =>
    a.alive || !a.stale || a.state === 'working' || a.state === 'reviewing' ||
    a.state === 'brainstorming' || (a.age_sec != null && a.age_sec < RECENT_THRESHOLD)
  )
  const staleAgents = agents.filter(a =>
    !a.alive && a.stale && a.state !== 'working' && a.state !== 'reviewing' &&
    a.state !== 'brainstorming' && (a.age_sec == null || a.age_sec >= RECENT_THRESHOLD)
  )
  const visibleAgents = showAllAgents ? agents : activeAgents
  const toggleShowAll = useCallback(() => {
    setShowAllAgents(prev => {
      const next = !prev
      try { localStorage.setItem('hq-show-all-agents', String(next)) } catch {}
      return next
    })
  }, [])
  const maxIssues = Math.max(...projects.map(p => p.open), 1)
  const pinboard = data?.pinboard || []
  const objectives = data?.objectives || []

  const cookMode = data?.cook_mode || { active: false }
  const stateLabel = cookMode.active ? '🔥 COOKING' : (lead.state || 'idle').toUpperCase()
  const beaconState = cookMode.active ? 'cooking' : (lead.state || 'idle')

  dbg('render', `App render #${renderCount}: data=${!!data}, agents=${agents.length}, pinboard=${pinboard.length}, cooking=${cookMode.active}`)

  return (
    <div className={`hq ${cookMode.active ? 'cook-mode-active' : ''}`}>
      <div className="hq-header">
        <StatusBeacon state={beaconState} />
        <div className="hq-title">
          <div className="state-label"
            style={{ color: cookMode.active ? 'var(--orange)' : (STATE_COLORS[lead.state] || 'var(--text-dim)') }}>
            {stateLabel}
          </div>
          {cookMode.active && (
            <div className="cook-badge">
              <span className="cook-badge-icon">👨‍🍳</span>
              <span className="cook-badge-task">{cookMode.task || 'Autonomous mode'}</span>
              {cookMode.messages_queued > 0 && (
                <span className="cook-badge-queue">{cookMode.messages_queued} queued</span>
              )}
            </div>
          )}
          <ObjectivesLog objectives={objectives} currentTask={lead.task || 'Standing by'} />
        </div>
        <div className="hq-meta">
          <Clock />
          <div className="branding">
            Wasteland HQ
            <span className="pulse-dot" />
          </div>
          {data?.timestamp && (
            <div className="last-update">
              data: {new Date(data.timestamp).toLocaleTimeString()}
            </div>
          )}
        </div>
      </div>

      {/* ── Tab Navigation ── */}
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />

      {/* ── Dashboard View ── */}
      {activeTab === 'dashboard' && (
        <>
          <div className="agents-section">
            <div className="section-label">
              Agents
              {activeAgents.length < agents.length && (
                <button className="agents-toggle" onClick={toggleShowAll}>
                  {showAllAgents
                    ? `Hide stale (${staleAgents.length})`
                    : `Show all (${agents.length})`
                  }
                </button>
              )}
            </div>
            <div className="agent-grid">
              {visibleAgents.map(a => <AgentCard key={a.agent} agent={a} />)}
            </div>
          </div>

          <PinboardSection notes={pinboard} />

          <div className="projects-section">
            <div className="section-label">Projects</div>
            <div className="project-rows">
              {projects.map(p => <ProjectRow key={p.name} project={p} maxIssues={maxIssues} />)}
            </div>
          </div>

          <SummaryBar agents={agents} projects={projects} />
        </>
      )}

      {/* ── Tech Tree View ── */}
      {activeTab === 'techtree' && <TechTree />}

      {error && (
        <div style={{ color: 'var(--red)', fontSize: '0.75rem', marginTop: 12 }}>
          Connection error: {error}
        </div>
      )}
    </div>
  )
}
