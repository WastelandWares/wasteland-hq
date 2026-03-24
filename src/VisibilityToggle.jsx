import './VisibilityToggle.css'

// ── Shared visibility toggle button ──────────
// Used by any section that hides stale/done items
export default function VisibilityToggle({ showAll, hiddenCount, onToggle, showLabel, hideLabel }) {
  if (hiddenCount === 0) return null

  return (
    <button className="visibility-toggle" onClick={onToggle}>
      {showAll
        ? (hideLabel || `Hide ${hiddenCount}`)
        : (showLabel || `Show all (+${hiddenCount})`)
      }
    </button>
  )
}
