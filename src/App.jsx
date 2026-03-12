import { useState, useEffect } from 'react'
import './App.css'
import TechTree from './TechTree.jsx'
import VisibilityToggle from './VisibilityToggle.jsx'
import { useVisibilityToggle, isAgentStale, isPinDone } from './useVisibilityToggle.js'

const STATE_COLORS = {
  working: 'var(--green)',
  idle: 'var(--text-dim)',
  reviewing: 'var(--purple)',
  brainstorming: 'var(--yellow)',
  blocked: 'var(--red)',
  meeting: 'var(--purple)',
  starting: 'var(--blue)',
  stopping: 'var(--text-dim)',
}

function useStatus(interval = 3000) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/status.json?' + Date.now())
        if (res.ok) {
          setData(await res.json())
          setError(null)
        }
      } catch (e) {
        setError(e.message)
      }
    }
    fetchStatus()
    const id = setInterval(fetchStatus, interval)
    return () => clearInterval(id)
  }, [interval])

  return { data, error }
}

function useIssueStats(interval = 30000) {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/issue-stats?' + Date.now())
        if (res.ok) setStats(await res.json())
      } catch {
        // Silently fail — summary bar shows fallback
      }
    }
    fetchStats()
    const id = setInterval(fetchStats, interval)
    return () => clearInterval(id)
  }, [interval])

  return stats
}

function useClock() {
  const [time, setTime] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return time
}

function getLeadAgent(agents) {
  // Find the PM agent, or the first working agent, or first agent
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

function SummaryBar({ agents, issueStats }) {
  const working = agents?.filter(a => a.state === 'working' && a.alive).length || 0
  const idle = agents?.filter(a => a.state === 'idle').length || 0
  const stale = agents?.filter(isAgentStale).length || 0

  return (
    <div className="summary-bar">
      {/* Agent stats */}
      <div className="summary-group">
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
      </div>

      {/* Separator */}
      <div className="summary-divider" />

      {/* Issue stats */}
      <div className="summary-group">
        <div className="summary-stat">
          <div className="dot blue" />
          <span className="value">{issueStats?.open ?? '–'}</span> open
        </div>
        <div className="summary-stat">
          <div className="dot cyan" />
          <span className="value">{issueStats?.inProgress ?? '–'}</span> in progress
        </div>
        {(issueStats?.stalled ?? 0) > 0 && (
          <div className="summary-stat">
            <div className="dot yellow" />
            <span className="value">{issueStats.stalled}</span> stalled
          </div>
        )}
        <div className="summary-stat">
          <div className="dot green" />
          <span className="value">{issueStats?.recentlyClosed ?? '–'}</span> closed <span className="stat-detail">48h</span>
        </div>
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
  const issueStats = useIssueStats(30000)
  const clock = useClock()
  const [activeTab, setActiveTab] = useState('dashboard')

  const agents = data?.agents || []
  const projects = data?.projects || []
  const pinboard = data?.pinboard || []
  const lead = getLeadAgent(agents)
  const maxIssues = Math.max(...projects.map(p => p.open), 1)

  // Shared visibility toggles using the DRY hook
  const agentVis = useVisibilityToggle('hq-show-all-agents', {
    items: agents,
    isHidden: isAgentStale,
  })
  const pinVis = useVisibilityToggle('hq-show-done-pins', {
    items: pinboard,
    isHidden: isPinDone,
  })

  const timeStr = clock.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const stateLabel = (lead.state || 'idle').toUpperCase()

  return (
    <div className="hq">
      {/* ── Big Status Header ── */}
      <div className="hq-header">
        <StatusBeacon state={lead.state || 'idle'} />
        <div className="hq-title">
          <div
            className="state-label"
            style={{ color: STATE_COLORS[lead.state] || 'var(--text-dim)' }}
          >
            {stateLabel}
          </div>
          <div className="task-label">{lead.task || 'Standing by'}</div>
        </div>
        <div className="hq-meta">
          <div className="clock">{timeStr}</div>
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
          {/* ── Agents ── */}
          <div className="agents-section">
            <div className="section-label">
              Agents
              <VisibilityToggle
                showAll={agentVis.showAll}
                hiddenCount={agentVis.hiddenCount}
                onToggle={agentVis.toggle}
                hideLabel={`Hide stale (${agentVis.hiddenCount})`}
                showLabel={`Show all (${agents.length})`}
              />
            </div>
            <div className="agent-grid">
              {agentVis.visible.map(a => (
                <AgentCard key={a.agent} agent={a} />
              ))}
            </div>
          </div>

          {/* ── Pinboard ── */}
          {pinboard.length > 0 && (
            <div className="pinboard-section">
              <div className="section-label">
                Pinboard
                <VisibilityToggle
                  showAll={pinVis.showAll}
                  hiddenCount={pinVis.hiddenCount}
                  onToggle={pinVis.toggle}
                  hideLabel={`Hide done (${pinVis.hiddenCount})`}
                  showLabel={`Show all (+${pinVis.hiddenCount} done)`}
                />
              </div>
              <div className="pin-grid">
                {pinVis.visible.map(note => (
                  <div key={note.id} className={`pin-card ${note.done ? 'done' : ''} ${note.priority === 'urgent' ? 'urgent' : ''}`}>
                    <div className="pin-text">{note.text}</div>
                    {note.project && <div className="pin-project">{note.project}</div>}
                    {note.tags?.length > 0 && (
                      <div className="pin-tags">
                        {note.tags.map(t => <span key={t} className="pin-tag">{t}</span>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Projects ── */}
          <div className="projects-section">
            <div className="section-label">Projects</div>
            <div className="project-rows">
              {projects.map(p => (
                <ProjectRow key={p.name} project={p} maxIssues={maxIssues} />
              ))}
            </div>
          </div>

          {/* ── Summary ── */}
          <SummaryBar agents={agents} issueStats={issueStats} />
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
