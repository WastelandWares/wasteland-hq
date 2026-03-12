# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Daily summary log with browsable dashboard tab (#19)
  - New DailyLog component for tracking and viewing daily summaries
  - Integration with dashboard interface
- Story bar expansion in tech tree visualization
- Visibility toggle control for UI elements

### Changed
- Migrated from Gitea API to GitHub API (#24)
  - Updated data fetching and synchronization
  - Improved GitHub integration
- Repository configuration refactoring
  - Streamlined vite config
  - Optimized plugin integration
- Tech tree rendering improvements
  - Fixed rendering bugs
  - Improved performance

### Fixed
- Tech tree visualization bugs
- Stale item handling with DRY refactor
  - Eliminated duplicate logic
  - Improved maintainability

## [0.0.1] - Initial Release

### Added
- React + Vite setup with HMR
- Tech tree visualization using Dagre
- ESLint configuration
- Basic dashboard interface
