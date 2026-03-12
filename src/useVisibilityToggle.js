import { useState, useCallback } from 'react'

// ── Shared stale/visibility constants ────────
export const STALE_THRESHOLD_SEC = 30 * 60 // 30 minutes

// ── Reusable visibility toggle hook ──────────
// storageKey: localStorage key for persisting toggle state
// Returns: { showAll, toggle, hiddenCount }
export function useVisibilityToggle(storageKey, { items = [], isHidden }) {
  const [showAll, setShowAll] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === 'true'
    } catch {
      return false
    }
  })

  const toggle = useCallback(() => {
    setShowAll(prev => {
      const next = !prev
      try { localStorage.setItem(storageKey, String(next)) } catch {}
      return next
    })
  }, [storageKey])

  const filtered = items.filter(item => !isHidden(item))
  const visible = showAll ? items : filtered
  const hiddenCount = items.length - filtered.length

  return { showAll, toggle, visible, hiddenCount }
}

// ── Agent staleness check ────────────────────
export function isAgentStale(agent) {
  if (agent.alive) return false
  if (!agent.stale) return false
  // Working/reviewing/brainstorming agents are never "stale" for display
  if (['working', 'reviewing', 'brainstorming'].includes(agent.state)) return false
  // Recent heartbeat within threshold
  if (agent.age_sec != null && agent.age_sec < STALE_THRESHOLD_SEC) return false
  return true
}

// ── Pinboard done check ──────────────────────
export function isPinDone(note) {
  return !!note.done
}
