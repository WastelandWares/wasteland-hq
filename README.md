# Wasteland HQ

A React + Vite application for managing tech trees and daily summary logs with GitHub integration.

## Features

- **Tech Tree Visualization**: Interactive graph-based visualization of technology dependencies and progression
  - Built with [Dagre](https://dagrejs.org/) for layout calculations
  - Dynamic node rendering and relationship management
  - Story bar expansion and visibility controls

- **Daily Log Dashboard**: Browsable daily summary log interface
  - Track and view daily progress summaries
  - Integrated dashboard tab
  - Persistent data storage

- **GitHub Integration**: Seamless synchronization with GitHub repositories
  - Automatic data fetching and updates
  - Issue and pull request tracking

## Project Structure

```
src/
├── App.jsx                 # Main application component
├── App.css                 # Application styles
├── TechTree.jsx           # Tech tree visualization component
├── TechTree.css           # Tech tree styles
├── DailyLog.jsx           # Daily log dashboard component
├── DailyLog.css           # Daily log styles
├── VisibilityToggle.jsx   # Visibility control component
├── useVisibilityToggle.js # Visibility toggle hook
├── config/                # Configuration files
└── assets/                # Static assets
```

## Development

### Setup
```bash
npm install
npm run dev
```

### Build
```bash
npm run build
npm run preview
```

### Lint
```bash
npm lint
```

## Technology Stack

- **React 19** - UI framework
- **Vite 7** - Build tool with HMR
- **Dagre** - Graph layout and visualization
- **ESLint** - Code quality

## Contributing

See the [CLAUDE.md](./CLAUDE.md) file for development guidelines and conventions.
