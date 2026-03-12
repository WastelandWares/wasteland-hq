import { useState, useEffect, useCallback } from 'react'
import './DailyLog.css'

/* ── Constants ────────────────────────────── */
const MS_PER_DAY = 86400000

/* ── Date helpers ─────────────────────────── */
function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function daysAgo(dateStr) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(dateStr + 'T00:00:00')
  const diff = Math.floor((today - target) / MS_PER_DAY)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return `${diff} days ago`
}

/* ── Detail View ─────────────────────────── */
function SummaryDetail({ summary, onBack }) {
  return (
    <div className="daily-detail">
      <button className="daily-back-btn" onClick={onBack}>
        &larr; Back to log
      </button>

      {summary._fetchError && (
        <div style={{ padding: '12px', marginBottom: '12px', backgroundColor: '#fff3cd', color: '#856404', borderRadius: '4px', fontSize: '14px' }}>
          ⚠ Could not load full details. Showing preview.
        </div>
      )}

      <div className="daily-detail-header">
        <h2 className="daily-detail-date">{formatDate(summary.date)}</h2>
        <span className="daily-detail-ago">{daysAgo(summary.date)}</span>
      </div>

      {/* Prose */}
      <div className="daily-section">
        <div className="daily-section-label">Summary</div>
        <p className="daily-prose">{summary.prose}</p>
      </div>

      {/* Highlights */}
      {summary.highlights && summary.highlights.length > 0 && (
        <div className="daily-section">
          <div className="daily-section-label">Highlights</div>
          <ul className="daily-highlights">
            {summary.highlights.map((h, i) => (
              <li key={i} className="daily-highlight-item">{h}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Open Issues */}
      {summary.open_issues && Object.keys(summary.open_issues).length > 0 && (
        <div className="daily-section">
          <div className="daily-section-label">Open Issues Snapshot</div>
          <div className="daily-issues-grid">
            {Object.entries(summary.open_issues).map(([repo, data]) => (
              <div key={repo} className="daily-issue-card">
                <div className="daily-issue-repo">{repo}</div>
                <div className="daily-issue-count">{data.count}</div>
                {data.notable && data.notable.length > 0 && (
                  <ul className="daily-issue-notable">
                    {data.notable.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      {summary.notes && summary.notes.length > 0 && (
        <div className="daily-section">
          <div className="daily-section-label">Notes</div>
          <ul className="daily-notes">
            {summary.notes.map((n, i) => (
              <li key={i} className="daily-note-item">{n}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Metrics */}
      {summary.metrics && (
        <div className="daily-section">
          <div className="daily-section-label">Metrics</div>
          <div className="daily-metrics">
            <div className="daily-metric">
              <span className="daily-metric-value">{summary.metrics.commits || 0}</span>
              <span className="daily-metric-label">commits</span>
            </div>
            <div className="daily-metric">
              <span className="daily-metric-value">{summary.metrics.prs_merged || 0}</span>
              <span className="daily-metric-label">PRs merged</span>
            </div>
            <div className="daily-metric">
              <span className="daily-metric-value">{summary.metrics.issues_created || 0}</span>
              <span className="daily-metric-label">created</span>
            </div>
            <div className="daily-metric">
              <span className="daily-metric-value">{summary.metrics.issues_closed || 0}</span>
              <span className="daily-metric-label">closed</span>
            </div>
          </div>
        </div>
      )}

      {summary.generated_at && (
        <div className="daily-generated">
          Generated {new Date(summary.generated_at).toLocaleString()}
        </div>
      )}
    </div>
  )
}

/* ── Day Card ─────────────────────────────── */
function DayCard({ entry, onClick }) {
  const totalIssues = entry.open_issues
    ? Object.values(entry.open_issues).reduce((s, d) => s + (d.count || 0), 0)
    : 0
  const highlightCount = entry.highlights?.length || 0

  return (
    <div className="daily-card" onClick={onClick}>
      <div className="daily-card-header">
        <span className="daily-card-date">{formatDate(entry.date)}</span>
        <span className="daily-card-ago">{daysAgo(entry.date)}</span>
      </div>
      <p className="daily-card-prose">{entry.prose}</p>
      <div className="daily-card-stats">
        {entry.metrics && (
          <>
            <span className="daily-card-stat">
              <span className="stat-dot commits" />
              {entry.metrics.commits || 0} commits
            </span>
            <span className="daily-card-stat">
              <span className="stat-dot merged" />
              {entry.metrics.prs_merged || 0} merged
            </span>
          </>
        )}
        {highlightCount > 0 && (
          <span className="daily-card-stat">
            <span className="stat-dot highlights" />
            {highlightCount} highlights
          </span>
        )}
        {totalIssues > 0 && (
          <span className="daily-card-stat">
            <span className="stat-dot issues" />
            {totalIssues} open issues
          </span>
        )}
      </div>
    </div>
  )
}

/* ── Main Component ───────────────────────── */
export default function DailyLog() {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedEntry, setSelectedEntry] = useState(null)

  useEffect(() => {
    const fetchLog = async () => {
      try {
        const res = await fetch('/api/daily-log?' + Date.now())
        if (res.ok) {
          const data = await res.json()
          setEntries(data.entries || [])
          setError(null)
        } else {
          setError(`Failed to fetch daily log: ${res.status}`)
        }
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    fetchLog()
  }, [])

  const handleSelect = useCallback(async (entry) => {
    // If we only have a preview, fetch the full entry
    if (!entry.highlights && entry.date) {
      try {
        const res = await fetch(`/api/daily-log/${entry.date}?` + Date.now())
        if (res.ok) {
          const full = await res.json()
          setSelectedEntry(full)
          return
        }
      } catch {
        // Fall through to using the preview, but mark the error
        setSelectedEntry({ ...entry, _fetchError: true })
        return
      }
      // Fetch failed, show preview with error indication
      setSelectedEntry({ ...entry, _fetchError: true })
      return
    }
    setSelectedEntry(entry)
  }, [])

  const handleBack = useCallback(() => {
    setSelectedEntry(null)
  }, [])

  if (loading) {
    return (
      <div className="daily-log-container">
        <div className="daily-loading">
          <div className="loading-spinner" />
          <span>Loading daily log...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="daily-log-container">
        <div className="daily-error">
          <span className="error-icon">&#9888;</span>
          <span>{error}</span>
          <div className="daily-error-hint">
            Run <code>python3 ~/.claude/bin/generate-daily-summary.py</code> to generate summaries
          </div>
        </div>
      </div>
    )
  }

  if (selectedEntry) {
    return (
      <div className="daily-log-container">
        <SummaryDetail summary={selectedEntry} onBack={handleBack} />
      </div>
    )
  }

  return (
    <div className="daily-log-container">
      <div className="daily-log-header">
        <span className="daily-log-title">Operations Log</span>
        <span className="daily-log-count">{entries.length} entries</span>
      </div>
      <div className="daily-log-list">
        {entries.length === 0 ? (
          <div className="daily-empty">
            <p>No daily summaries yet.</p>
            <p className="daily-empty-hint">
              Run <code>python3 ~/.claude/bin/generate-daily-summary.py</code> to generate the first summary.
            </p>
          </div>
        ) : (
          entries.map((entry) => (
            <DayCard
              key={entry.date}
              entry={entry}
              onClick={() => handleSelect(entry)}
            />
          ))
        )}
      </div>
    </div>
  )
}
