import { useState, useEffect, useRef, useCallback } from 'react'
import dagre from '@dagrejs/dagre'
import { REPO_COLORS, REPO_COLORS_DIM } from './config/repos.js'
import './TechTree.css'

// ── Project colors (from centralized config) ─
const PROJECT_COLORS = REPO_COLORS
const PROJECT_COLOR_DIM = REPO_COLORS_DIM

// ── Complexity shapes ───────────────────────
// trivial = small circle, small = circle, medium = rounded rect, large = rect, epic = diamond
const COMPLEXITY_MAP = {
  trivial: 'circle-sm',
  small: 'circle',
  medium: 'rect',
  large: 'rect-lg',
  epic: 'diamond',
}

// ── Status indicators ───────────────────────
const STATUS_CONFIG = {
  blocked: { icon: '🔒', label: 'Blocked', class: 'blocked' },
  'in-progress': { icon: '🔧', label: 'In Progress', class: 'in-progress' },
  'in-review': { icon: '🔍', label: 'In Review', class: 'in-review' },
  merged: { icon: '✅', label: 'Merged', class: 'merged' },
  planned: { icon: '💡', label: 'Planned', class: 'planned' },
  icebox: { icon: '❄️', label: 'Icebox', class: 'icebox' },
}

// ── Parsing ─────────────────────────────────
function extractDependencies(issue) {
  const deps = []
  const text = `${issue.title} ${issue.body}`

  // Cross-ref pattern: "cross-ref repo#N" or "blocked by repo#N" or "depends on repo#N"
  const crossRefPattern = /(?:cross[- ]ref|blocked\s+by|depends\s+on|requires|after)\s+([a-zA-Z0-9_-]+)#(\d+)/gi
  let match
  while ((match = crossRefPattern.exec(text)) !== null) {
    deps.push({ repo: match[1], number: parseInt(match[2]) })
  }

  // Same-repo pattern: "blocked by #N" or "depends on #N"
  const sameRepoPattern = /(?:blocked\s+by|depends\s+on|requires|after)\s+#(\d+)/gi
  while ((match = sameRepoPattern.exec(text)) !== null) {
    deps.push({ repo: issue.repo, number: parseInt(match[1]) })
  }

  return deps
}

function getIssueStatus(issue) {
  const labels = issue.labels.map((l) => l.name.toLowerCase())

  if (labels.includes('icebox') || labels.includes('tier:icebox')) return 'icebox'
  if (issue.pull_request) return 'in-review'
  if (labels.includes('in-progress') || labels.includes('tier:now') || labels.some(l => l.includes('sprint')))
    return 'in-progress'
  if (labels.includes('needs-breakdown') || labels.includes('needs:brainstorm'))
    return 'blocked'
  if (issue.state === 'closed') return 'merged'
  return 'planned'
}

function getComplexity(issue) {
  const labels = issue.labels.map((l) => l.name.toLowerCase())
  for (const level of ['epic', 'large', 'medium', 'small', 'trivial']) {
    if (labels.some((l) => l.includes(`complexity:${level}`) || l === level))
      return level
  }
  return 'medium' // default
}

// Find connected components using union-find
function findComponents(nodeKeys, edgeList) {
  const parent = new Map()
  for (const key of nodeKeys) parent.set(key, key)

  function find(x) {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)))
      x = parent.get(x)
    }
    return x
  }
  function union(a, b) {
    parent.set(find(a), find(b))
  }

  for (const { from, to } of edgeList) {
    if (parent.has(from) && parent.has(to)) union(from, to)
  }

  const groups = new Map()
  for (const key of nodeKeys) {
    const root = find(key)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(key)
  }
  return [...groups.values()]
}

function buildGraph(issues) {
  const nodeMap = new Map()
  const nodeWidth = 220
  const nodeHeight = 80

  // Build all node data
  for (const issue of issues) {
    const key = `${issue.repo}#${issue.number}`
    const status = getIssueStatus(issue)
    const complexity = getComplexity(issue)

    nodeMap.set(key, {
      ...issue,
      key,
      status,
      complexity,
      color: PROJECT_COLORS[issue.repo] || '#4ea8ff',
      colorDim: PROJECT_COLOR_DIM[issue.repo] || '#4ea8ff30',
    })
  }

  // Collect all edges
  const allEdges = []
  for (const issue of issues) {
    const deps = extractDependencies(issue)
    const toKey = `${issue.repo}#${issue.number}`
    for (const dep of deps) {
      const fromKey = `${dep.repo}#${dep.number}`
      if (nodeMap.has(fromKey)) {
        allEdges.push({ from: fromKey, to: toKey })
      }
    }
  }

  // Mark needs-breakdown nodes
  for (const issue of issues) {
    const labels = issue.labels.map(l => l.name.toLowerCase())
    if (labels.includes('needs-breakdown') || labels.includes('needs:brainstorm')) {
      const key = `${issue.repo}#${issue.number}`
      const node = nodeMap.get(key)
      if (node) node.needsBreakdown = true
    }
  }

  // Split into connected components
  const nodeKeys = [...nodeMap.keys()]
  const components = findComponents(nodeKeys, allEdges)

  // Sort components: largest first, then by whether they have edges
  components.sort((a, b) => {
    const aHasEdges = allEdges.some(e => a.includes(e.from) || a.includes(e.to))
    const bHasEdges = allEdges.some(e => b.includes(e.from) || b.includes(e.to))
    if (aHasEdges !== bHasEdges) return bHasEdges ? 1 : -1
    return b.length - a.length
  })

  // Layout each component separately with dagre, then arrange in a grid
  const allNodes = []
  const allPositionedEdges = []
  const COMPONENT_GAP_X = 80
  const COMPONENT_GAP_Y = 80

  // Grid columns based on component count
  const numCols = components.length <= 2 ? components.length
    : components.length <= 6 ? 3
    : 4

  let gridX = 0
  let gridY = 0
  let colIndex = 0
  let currentRowHeight = 0

  for (const component of components) {
    // Build a sub-graph for this component
    const g = new dagre.graphlib.Graph()
    g.setGraph({
      rankdir: 'TB',
      ranksep: 100,
      nodesep: 60,
      marginx: 20,
      marginy: 20,
    })
    g.setDefaultEdgeLabel(() => ({}))

    for (const key of component) {
      g.setNode(key, { width: nodeWidth, height: nodeHeight })
    }

    // Add edges belonging to this component
    const compSet = new Set(component)
    for (const edge of allEdges) {
      if (compSet.has(edge.from) && compSet.has(edge.to)) {
        g.setEdge(edge.from, edge.to)
      }
    }

    dagre.layout(g)

    // Find bounding box of this component layout
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    g.nodes().forEach((key) => {
      const n = g.node(key)
      if (n) {
        minX = Math.min(minX, n.x - nodeWidth / 2)
        minY = Math.min(minY, n.y - nodeHeight / 2)
        maxX = Math.max(maxX, n.x + nodeWidth / 2)
        maxY = Math.max(maxY, n.y + nodeHeight / 2)
      }
    })

    const compWidth = maxX - minX
    const compHeight = maxY - minY

    // Offset nodes to grid position
    const offsetX = gridX - minX
    const offsetY = gridY - minY

    g.nodes().forEach((key) => {
      const layoutNode = g.node(key)
      const data = nodeMap.get(key)
      if (data && layoutNode) {
        allNodes.push({
          ...data,
          x: layoutNode.x + offsetX,
          y: layoutNode.y + offsetY,
          width: nodeWidth,
          height: nodeHeight,
        })
      }
    })

    // Offset edges
    g.edges().forEach((e) => {
      const edgeData = g.edge(e)
      if (edgeData?.points) {
        allPositionedEdges.push({
          from: e.v,
          to: e.w,
          points: edgeData.points.map(p => ({ x: p.x + offsetX, y: p.y + offsetY })),
          fromColor: nodeMap.get(e.v)?.color || '#4ea8ff',
        })
      }
    })

    // Advance grid position
    currentRowHeight = Math.max(currentRowHeight, compHeight)
    colIndex++

    if (colIndex >= numCols) {
      // Next row
      gridX = 0
      gridY += currentRowHeight + COMPONENT_GAP_Y
      colIndex = 0
      currentRowHeight = 0
    } else {
      gridX += compWidth + COMPONENT_GAP_X
    }
  }

  return { nodes: allNodes, edges: allPositionedEdges }
}

// ── SVG Components ──────────────────────────
function EdgePath({ edge }) {
  if (!edge.points || edge.points.length < 2) return null

  const d = edge.points.reduce((path, pt, i) => {
    return path + (i === 0 ? `M ${pt.x} ${pt.y}` : ` L ${pt.x} ${pt.y}`)
  }, '')

  return (
    <g className="tech-edge">
      <path d={d} fill="none" stroke={edge.fromColor} strokeWidth="2" opacity="0.3" />
      <path
        d={d}
        fill="none"
        stroke={edge.fromColor}
        strokeWidth="2"
        opacity="0.7"
        strokeDasharray="6 4"
        className="edge-animated"
      />
      {/* Arrowhead */}
      <circle
        cx={edge.points[edge.points.length - 1].x}
        cy={edge.points[edge.points.length - 1].y}
        r="4"
        fill={edge.fromColor}
        opacity="0.6"
      />
    </g>
  )
}

function IssueNode({ node, onSelect, isSelected }) {
  const statusCfg = STATUS_CONFIG[node.status] || STATUS_CONFIG.planned
  const shortTitle =
    node.title.length > 35 ? node.title.slice(0, 35) + '…' : node.title
  const shortRepo = node.repo.replace('wasteland-', 'w-')

  return (
    <g
      className={`tech-node ${statusCfg.class} ${isSelected ? 'selected' : ''}`}
      transform={`translate(${node.x - node.width / 2}, ${node.y - node.height / 2})`}
      onClick={() => onSelect(node)}
      style={{ cursor: 'pointer' }}
    >
      {/* Background */}
      <rect
        width={node.width}
        height={node.height}
        rx="8"
        fill={node.colorDim}
        stroke={node.color}
        strokeWidth={isSelected ? '2' : '1'}
        opacity={node.status === 'icebox' ? 0.4 : 0.9}
      />

      {/* Status stripe */}
      <rect
        width="4"
        height={node.height}
        rx="4"
        fill={node.color}
        opacity={node.status === 'merged' ? 1 : 0.6}
      />

      {/* Status icon */}
      <text x="16" y="22" fontSize="14">
        {statusCfg.icon}
      </text>

      {/* Repo + Number */}
      <text
        x="34"
        y="22"
        fill={node.color}
        fontSize="10"
        fontFamily="var(--font-body)"
        fontWeight="600"
      >
        {shortRepo}#{node.number}
      </text>

      {/* Complexity badge */}
      <text
        x={node.width - 8}
        y="22"
        fill="var(--text-dim)"
        fontSize="9"
        fontFamily="var(--font-body)"
        textAnchor="end"
      >
        {node.complexity}
      </text>

      {/* Title */}
      <text
        x="16"
        y="48"
        fill="var(--text-primary)"
        fontSize="11"
        fontFamily="var(--font-body)"
        fontWeight="400"
      >
        {shortTitle}
      </text>

      {/* Labels indicator */}
      {node.needsBreakdown && (
        <text
          x="16"
          y="68"
          fill="var(--yellow)"
          fontSize="9"
          fontFamily="var(--font-body)"
        >
          ⚠ needs breakdown
        </text>
      )}
    </g>
  )
}

// ── Filters ─────────────────────────────────
function FilterBar({ repos, activeRepos, onToggle, statusFilter, onStatusFilter }) {
  return (
    <div className="tech-filters">
      <div className="filter-group">
        <span className="filter-label">Projects</span>
        <div className="filter-chips">
          {repos.map((repo) => (
            <button
              key={repo}
              className={`filter-chip ${activeRepos.has(repo) ? 'active' : ''}`}
              style={{
                borderColor: activeRepos.has(repo)
                  ? PROJECT_COLORS[repo] || '#4ea8ff'
                  : 'var(--border-subtle)',
                color: activeRepos.has(repo)
                  ? PROJECT_COLORS[repo] || '#4ea8ff'
                  : 'var(--text-dim)',
              }}
              onClick={() => onToggle(repo)}
            >
              <span
                className="chip-dot"
                style={{
                  background: PROJECT_COLORS[repo] || '#4ea8ff',
                  opacity: activeRepos.has(repo) ? 1 : 0.3,
                }}
              />
              {repo.replace('wasteland-', 'w-')}
            </button>
          ))}
        </div>
      </div>
      <div className="filter-group">
        <span className="filter-label">Status</span>
        <div className="filter-chips">
          {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
            <button
              key={key}
              className={`filter-chip ${statusFilter === key ? 'active' : ''} ${statusFilter === null ? 'active' : ''}`}
              onClick={() => onStatusFilter(statusFilter === key ? null : key)}
            >
              {cfg.icon} {cfg.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Detail Panel ────────────────────────────
function DetailPanel({ node, onClose }) {
  if (!node) return null
  const statusCfg = STATUS_CONFIG[node.status] || STATUS_CONFIG.planned

  return (
    <div className="tech-detail-panel">
      <div className="detail-header">
        <div className="detail-title-row">
          <span className="detail-status-icon">{statusCfg.icon}</span>
          <span
            className="detail-repo"
            style={{ color: node.color }}
          >
            {node.repo}#{node.number}
          </span>
          <button className="detail-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <h3 className="detail-title">{node.title}</h3>
      </div>
      <div className="detail-meta">
        <div className="detail-meta-item">
          <span className="meta-label">Status</span>
          <span className={`meta-value status-${node.status}`}>
            {statusCfg.label}
          </span>
        </div>
        <div className="detail-meta-item">
          <span className="meta-label">Complexity</span>
          <span className="meta-value">{node.complexity}</span>
        </div>
        {node.milestone && (
          <div className="detail-meta-item">
            <span className="meta-label">Milestone</span>
            <span className="meta-value">{node.milestone}</span>
          </div>
        )}
        {node.labels.length > 0 && (
          <div className="detail-meta-item">
            <span className="meta-label">Labels</span>
            <div className="detail-labels">
              {node.labels.map((l) => (
                <span
                  key={l.name}
                  className="detail-label-chip"
                  style={{ borderColor: `#${l.color}`, color: `#${l.color}` }}
                >
                  {l.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      <a
        href={node.url}
        target="_blank"
        rel="noopener noreferrer"
        className="detail-link"
      >
        Open in GitHub →
      </a>
    </div>
  )
}

// ── Main Component ──────────────────────────
export default function TechTree() {
  const [issues, setIssues] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedNode, setSelectedNode] = useState(null)
  const [activeRepos, setActiveRepos] = useState(new Set())
  const [statusFilter, setStatusFilter] = useState(null)
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const svgRef = useRef(null)
  const isPanning = useRef(false)
  const panStart = useRef({ x: 0, y: 0 })

  // Fetch issues
  useEffect(() => {
    const fetchIssues = async () => {
      try {
        const res = await fetch('/api/issues?' + Date.now())
        if (res.ok) {
          const data = await res.json()
          setIssues(data.issues || [])
          // Initialize active repos from available data
          const repos = new Set(data.issues.map((i) => i.repo))
          setActiveRepos(repos)
          setError(null)
        } else {
          setError(`Failed to fetch issues: ${res.status}`)
        }
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    fetchIssues()
  }, [])

  // Filter issues
  const filteredIssues = issues.filter((issue) => {
    if (!activeRepos.has(issue.repo)) return false
    if (statusFilter) {
      const issueStatus = getIssueStatus(issue)
      if (issueStatus !== statusFilter) return false
    }
    return true
  })

  // Build graph
  const graph = buildGraph(filteredIssues)

  // Calculate SVG viewBox
  const padding = 60
  const minX = Math.min(...graph.nodes.map((n) => n.x - n.width / 2), 0) - padding
  const minY = Math.min(...graph.nodes.map((n) => n.y - n.height / 2), 0) - padding
  const maxX = Math.max(...graph.nodes.map((n) => n.x + n.width / 2), 400) + padding
  const maxY = Math.max(...graph.nodes.map((n) => n.y + n.height / 2), 300) + padding

  // Pan & zoom handlers
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setTransform((t) => ({
      ...t,
      scale: Math.max(0.2, Math.min(3, t.scale * delta)),
    }))
  }, [])

  const handleMouseDown = useCallback((e) => {
    if (e.target.closest('.tech-node')) return
    isPanning.current = true
    panStart.current = { x: e.clientX - transform.x, y: e.clientY - transform.y }
  }, [transform])

  const handleMouseMove = useCallback((e) => {
    if (!isPanning.current) return
    setTransform((t) => ({
      ...t,
      x: e.clientX - panStart.current.x,
      y: e.clientY - panStart.current.y,
    }))
  }, [])

  const handleMouseUp = useCallback(() => {
    isPanning.current = false
  }, [])

  const repos = [...new Set(issues.map((i) => i.repo))].sort()

  const handleToggleRepo = (repo) => {
    setActiveRepos((prev) => {
      const next = new Set(prev)
      if (next.has(repo)) next.delete(repo)
      else next.add(repo)
      return next
    })
  }

  const handleResetView = () => {
    setTransform({ x: 0, y: 0, scale: 1 })
  }

  if (loading) {
    return (
      <div className="tech-tree-container">
        <div className="tech-loading">
          <div className="loading-spinner" />
          <span>Scanning GitHub for issues…</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="tech-tree-container">
        <div className="tech-error">
          <span className="error-icon">⚠</span>
          <span>Connection to GitHub failed: {error}</span>
          <div className="error-hint">
            Check your GitHub token and network connection
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="tech-tree-container">
      <FilterBar
        repos={repos}
        activeRepos={activeRepos}
        onToggle={handleToggleRepo}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
      />

      <div className="tech-canvas-wrapper">
        <div className="tech-canvas-controls">
          <button className="canvas-btn" onClick={() => setTransform(t => ({ ...t, scale: t.scale * 1.2 }))}>+</button>
          <button className="canvas-btn" onClick={() => setTransform(t => ({ ...t, scale: t.scale * 0.8 }))}>−</button>
          <button className="canvas-btn" onClick={handleResetView}>⊙</button>
          <span className="canvas-info">
            {filteredIssues.length} issues · {graph.edges.length} deps
          </span>
        </div>

        <svg
          ref={svgRef}
          className="tech-canvas"
          viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
            {/* Grid pattern */}
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path
                  d="M 40 0 L 0 0 0 40"
                  fill="none"
                  stroke="var(--border-subtle)"
                  strokeWidth="0.5"
                  opacity="0.3"
                />
              </pattern>
            </defs>
            <rect
              x={minX - 500}
              y={minY - 500}
              width={maxX - minX + 1000}
              height={maxY - minY + 1000}
              fill="url(#grid)"
            />

            {/* Edges */}
            {graph.edges.map((edge, i) => (
              <EdgePath key={`${edge.from}-${edge.to}-${i}`} edge={edge} />
            ))}

            {/* Nodes */}
            {graph.nodes.map((node) => (
              <IssueNode
                key={node.key}
                node={node}
                onSelect={setSelectedNode}
                isSelected={selectedNode?.key === node.key}
              />
            ))}
          </g>
        </svg>
      </div>

      <DetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} />

      {/* Legend */}
      <div className="tech-legend">
        <div className="legend-section">
          <span className="legend-title">Status</span>
          {Object.entries(STATUS_CONFIG).map(([, cfg]) => (
            <span key={cfg.label} className="legend-item">
              {cfg.icon} {cfg.label}
            </span>
          ))}
        </div>
        <div className="legend-section">
          <span className="legend-title">Projects</span>
          {Object.entries(PROJECT_COLORS).map(([name, color]) => (
            <span key={name} className="legend-item">
              <span className="legend-dot" style={{ background: color }} />
              {name.replace('wasteland-', 'w-')}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
