#!/usr/bin/env python3
"""
collect-human-metrics.py — Extract human interaction metrics from Claude Code sessions.

Scans session transcripts (JSONL) to identify human (vs automated/tool) messages
and compute engagement metrics for the daily summary log.

Session JSONL format (discovered via research):
- type: "agent-setting" — session config with agentSetting (persona name), sessionId
- type: "user" with content:str — human text input
- type: "user" with content:list containing tool_result — tool response (not human)
- type: "user" with content:list without tool_result — system injection or human w/ images
- type: "assistant" — Claude responses
- type: "progress" — tool execution progress
- type: "system" — system messages (compaction, reminders)
- type: "queue-operation" — btw/cook queue ops

Human identification heuristic (conservative — prefers false negatives):
1. Must be type="user" with message.role="user"
2. content is a plain string (strongest signal) or array with text blocks but no tool_result
3. Filter out system injections: slash commands, task notifications, interruptions, continuations
4. Minimum length threshold to exclude trivial confirmations

Usage:
    python3 collect-human-metrics.py [--date YYYY-MM-DD] [--output PATH] [--verbose]
"""

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# --- Config ---
CLAUDE_PROJECTS_DIR = os.path.expanduser("~/.claude/projects")
SUMMARIES_DIR = os.path.expanduser("~/.claude/daily-summaries")
COOK_STATE_PATH = os.path.expanduser("~/.claude/state/cook-mode.json")

# Minimum character length for a message to count as substantive human input
MIN_HUMAN_MSG_LENGTH = 5


def log(msg):
    print(f"  [human-metrics] {msg}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Message classification
# ---------------------------------------------------------------------------

# Patterns that indicate system/automated content, not human input
SYSTEM_PREFIXES = [
    "<task-notification>",
    "<command-message>",
    "# /cook",
    "# /uncook",
    "[Request interrupted",
    "This session is being continued from a previous conversation",
    "SessionStart:",
    "<system-reminder>",
    "Contents of ",
    "Called the ",
    "Result of calling ",
    "Note:",
]

SYSTEM_PATTERNS = [
    re.compile(r"^<[a-z]+-[a-z]+>"),          # XML-style system tags
    re.compile(r"^\[Image: source:"),           # Image reference injections
    re.compile(r"^# /\w+"),                     # Slash command expansions
]


def extract_text(content):
    """Extract text from message content (string or content block array)."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    texts.append(block.get("text", ""))
        return " ".join(texts).strip()
    return ""


def has_tool_result(content):
    """Check if content array contains tool_result blocks."""
    if not isinstance(content, list):
        return False
    return any(
        isinstance(c, dict) and c.get("type") == "tool_result"
        for c in content
    )


def is_system_injection(text):
    """Check if text matches known system injection patterns."""
    for prefix in SYSTEM_PREFIXES:
        if text.startswith(prefix):
            return True
    for pat in SYSTEM_PATTERNS:
        if pat.match(text):
            return True
    return False


def is_human_message(entry):
    """
    Identify genuine human input vs system/tool messages.

    Conservative heuristic — prefers false negatives over false positives.
    Returns (is_human: bool, text: str, has_image: bool).
    """
    if entry.get("type") != "user":
        return False, "", False

    msg = entry.get("message", {})
    if not isinstance(msg, dict) or msg.get("role") != "user":
        return False, "", False

    content = msg.get("content", "")

    # Tool results are never human messages
    if has_tool_result(content):
        return False, "", False

    text = extract_text(content)

    # Too short = not substantive
    if len(text) < MIN_HUMAN_MSG_LENGTH:
        return False, "", False

    # System injections
    if is_system_injection(text):
        return False, "", False

    # Check for images (human sometimes sends screenshots)
    has_image = False
    if isinstance(content, list):
        has_image = any(
            isinstance(c, dict) and c.get("type") == "image"
            for c in content
        )

    return True, text, has_image


# ---------------------------------------------------------------------------
# Content classification (simple keyword-based)
# ---------------------------------------------------------------------------

def classify_message(text):
    """Classify a human message into categories. Returns list of matching categories."""
    text_lower = text.lower().strip()
    categories = []

    # Task/command patterns
    task_patterns = [
        r"\btask[:\s]", r"\bfix[:\s]", r"\bdispatch\b", r"\badd\b",
        r"\bimplement\b", r"\bcreate\b", r"\bbuild\b", r"\bdeploy\b",
        r"\brun\b", r"\bexecute\b", r"\bsetup\b", r"\binstall\b",
        r"\blet'?s\s+(get|keep|start|do)\b", r"\bplease proceed\b",
        r"\bgood plan\b.*proceed", r"\bgo ahead\b",
    ]
    if any(re.search(p, text_lower) for p in task_patterns):
        categories.append("tasks")

    # Idea/brainstorm patterns
    idea_patterns = [
        r"\bidea[:\s]", r"\bwhat if\b", r"\bconsider\b", r"\bmaybe\b",
        r"\bwe (should|could|might)\b", r"\bhow about\b", r"\bthink\b",
        r"\bdesign\b", r"\btier:", r"\bresearch\b",
    ]
    if any(re.search(p, text_lower) for p in idea_patterns):
        categories.append("ideas")

    # Feedback/correction patterns
    feedback_patterns = [
        r"\bno[,.]?\s", r"\bactually\b", r"\binstead\b", r"\bwrong\b",
        r"\bnot\s+(?:right|correct|what)\b", r"\bstill\b.*(?:broken|failing|disappear)",
        r"\bstill\s+(?:not|broken|failing)", r"\bbut\b",
    ]
    if any(re.search(p, text_lower) for p in feedback_patterns):
        categories.append("feedback")

    # Question patterns
    if "?" in text or any(
        re.search(p, text_lower)
        for p in [r"^(how|why|what|where|when|which|is there|does|can|do)\b"]
    ):
        categories.append("questions")

    # Acknowledgment patterns
    ack_patterns = [
        r"^(ok|okay|sure|yes|yep|yeah|good|great|nice|perfect|thanks|done)\b",
        r"\blooks? good\b", r"\bawesome\b", r"\bgot it\b",
    ]
    if any(re.search(p, text_lower) for p in ack_patterns):
        categories.append("acknowledgments")

    # Default: if nothing matched, classify as "other"
    if not categories:
        categories.append("other")

    return categories


# ---------------------------------------------------------------------------
# Session scanning
# ---------------------------------------------------------------------------

def find_sessions(target_date, projects_dir=CLAUDE_PROJECTS_DIR):
    """
    Find all session JSONL files that have activity on target_date.

    Returns list of (filepath, project_context, is_subagent) tuples.
    """
    sessions = []
    target_str = target_date.strftime("%Y-%m-%d")

    if not os.path.isdir(projects_dir):
        log(f"Projects dir not found: {projects_dir}")
        return sessions

    for project_dir in os.listdir(projects_dir):
        full_dir = os.path.join(projects_dir, project_dir)
        if not os.path.isdir(full_dir):
            continue

        # Main session files
        for f in os.listdir(full_dir):
            if f.endswith(".jsonl"):
                fpath = os.path.join(full_dir, f)
                # Quick check: was the file modified on or after target date?
                mtime = datetime.fromtimestamp(os.path.getmtime(fpath))
                # Include files modified on target date or within a day
                if mtime.strftime("%Y-%m-%d") >= target_str:
                    sessions.append((fpath, project_dir, False))

            # Check subagents directory
            if os.path.isdir(os.path.join(full_dir, f, "subagents")):
                sub_dir = os.path.join(full_dir, f, "subagents")
                for sf in os.listdir(sub_dir):
                    if sf.endswith(".jsonl"):
                        # Skip compact/continuation and side_question sessions
                        # These carry over messages from parent sessions, causing
                        # double-counting of human messages.
                        if "compact" in sf or "side_question" in sf:
                            continue
                        sfpath = os.path.join(sub_dir, sf)
                        mtime = datetime.fromtimestamp(os.path.getmtime(sfpath))
                        if mtime.strftime("%Y-%m-%d") >= target_str:
                            sessions.append((sfpath, project_dir, True))

    return sessions


def parse_timestamp(ts_str):
    """Parse ISO timestamp string to datetime."""
    if not ts_str:
        return None
    try:
        # Handle Z suffix
        ts_str = ts_str.replace("Z", "+00:00")
        return datetime.fromisoformat(ts_str)
    except (ValueError, TypeError):
        return None


def scan_session(filepath, target_date, verbose=False):
    """
    Scan a single session JSONL file and extract metrics.

    Returns dict with session-level metrics, or None if session has no
    activity on target_date.
    """
    target_str = target_date.strftime("%Y-%m-%d")
    session_id = Path(filepath).stem
    agent_name = None

    human_messages = []
    assistant_count = 0
    all_timestamps = []
    cook_events = []
    btw_events = []
    has_activity_on_date = False

    try:
        with open(filepath, "r", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Extract agent name from first entry
                if entry.get("type") == "agent-setting" and not agent_name:
                    agent_name = entry.get("agentSetting", "unknown")
                    continue

                ts_str = entry.get("timestamp", "")
                ts = parse_timestamp(ts_str)

                # Check if this entry is on our target date
                if ts and ts.strftime("%Y-%m-%d") == target_str:
                    has_activity_on_date = True

                # Track all timestamps for gap analysis
                if ts:
                    all_timestamps.append(ts)

                # Count assistant messages on target date
                if entry.get("type") == "assistant" and ts:
                    if ts.strftime("%Y-%m-%d") == target_str:
                        assistant_count += 1

                # Identify human messages
                is_human, text, has_image = is_human_message(entry)
                if is_human and ts:
                    if ts.strftime("%Y-%m-%d") == target_str:
                        categories = classify_message(text)
                        human_messages.append({
                            "timestamp": ts,
                            "text": text,
                            "length": len(text),
                            "has_image": has_image,
                            "categories": categories,
                        })

                # Track cook mode events
                if entry.get("type") == "queue-operation":
                    if ts and ts.strftime("%Y-%m-%d") == target_str:
                        cook_events.append(entry)

    except (OSError, IOError) as e:
        if verbose:
            log(f"Error reading {filepath}: {e}")
        return None

    if not has_activity_on_date:
        return None

    # Compute engagement gaps (time between consecutive human messages)
    human_timestamps = sorted(m["timestamp"] for m in human_messages)
    gaps_minutes = []
    for i in range(1, len(human_timestamps)):
        gap = (human_timestamps[i] - human_timestamps[i - 1]).total_seconds() / 60.0
        gaps_minutes.append(gap)

    # Compute longest autonomous stretch (gap between human messages)
    longest_autonomous = max(gaps_minutes) if gaps_minutes else 0

    # Classify session
    is_interactive = len(human_messages) >= 2

    # Content breakdown
    content_breakdown = Counter()
    for msg in human_messages:
        for cat in msg["categories"]:
            content_breakdown[cat] += 1

    return {
        "session_id": session_id,
        "agent": agent_name or "unknown",
        "filepath": filepath,
        "is_interactive": is_interactive,
        "human_messages": len(human_messages),
        "assistant_messages": assistant_count,
        "human_msg_details": human_messages,
        "avg_msg_length": (
            sum(m["length"] for m in human_messages) / len(human_messages)
            if human_messages
            else 0
        ),
        "images_sent": sum(1 for m in human_messages if m["has_image"]),
        "gaps_minutes": gaps_minutes,
        "avg_gap_minutes": (
            sum(gaps_minutes) / len(gaps_minutes) if gaps_minutes else 0
        ),
        "longest_autonomous_minutes": longest_autonomous,
        "content_breakdown": dict(content_breakdown),
        "cook_events": len(cook_events),
    }


# ---------------------------------------------------------------------------
# Aggregate metrics
# ---------------------------------------------------------------------------

def aggregate_metrics(session_results, target_date):
    """Aggregate individual session metrics into a summary."""
    total_sessions = len(session_results)
    interactive_sessions = [s for s in session_results if s["is_interactive"]]
    automated_sessions = [s for s in session_results if not s["is_interactive"]]

    total_human_msgs = sum(s["human_messages"] for s in session_results)
    total_assistant_msgs = sum(s["assistant_messages"] for s in session_results)

    # Aggregate content breakdown
    content_totals = Counter()
    for s in session_results:
        for cat, count in s["content_breakdown"].items():
            content_totals[cat] += count

    # Compute overall averages
    all_gaps = []
    for s in session_results:
        all_gaps.extend(s["gaps_minutes"])

    avg_gap = sum(all_gaps) / len(all_gaps) if all_gaps else 0
    longest_auto = max(
        (s["longest_autonomous_minutes"] for s in session_results), default=0
    )

    avg_per_interactive = (
        total_human_msgs / len(interactive_sessions)
        if interactive_sessions
        else 0
    )

    all_lengths = []
    for s in session_results:
        all_lengths.extend(m["length"] for m in s["human_msg_details"])
    avg_length = sum(all_lengths) / len(all_lengths) if all_lengths else 0
    median_length = sorted(all_lengths)[len(all_lengths) // 2] if all_lengths else 0

    # Human-to-assistant ratio
    ratio = (
        total_human_msgs / total_assistant_msgs
        if total_assistant_msgs > 0
        else 0
    )

    total_images = sum(s["images_sent"] for s in session_results)
    total_cook = sum(s["cook_events"] for s in session_results)

    # Top sessions by human involvement
    top_sessions = sorted(
        session_results, key=lambda s: s["human_messages"], reverse=True
    )[:5]

    # Project attention: derive project name from filepath
    project_attention = Counter()
    for s in session_results:
        # Extract project from directory name
        parts = s["filepath"].split("/")
        for part in parts:
            if part.startswith("-Users-tquick-projects"):
                proj = part.replace("-Users-tquick-projects-", "").replace("-Users-tquick-projects", "general")
                # Clean up worktree paths
                proj = proj.split("--worktrees")[0]
                project_attention[proj] += s["human_messages"]
                break

    return {
        "period": target_date.strftime("%Y-%m-%d"),
        "sessions": {
            "total": total_sessions,
            "interactive": len(interactive_sessions),
            "automated": len(automated_sessions),
        },
        "human_messages": {
            "total": total_human_msgs,
            "avg_per_interactive_session": round(avg_per_interactive, 1),
            "human_to_assistant_ratio": round(ratio, 3),
            "avg_length_chars": round(avg_length, 0),
            "median_length_chars": median_length,
            "images_shared": total_images,
        },
        "engagement": {
            "avg_gap_minutes": round(avg_gap, 1),
            "longest_autonomous_stretch_minutes": round(longest_auto, 1),
            "cook_mode_events": total_cook,
        },
        "content_breakdown": {
            "tasks": content_totals.get("tasks", 0),
            "ideas": content_totals.get("ideas", 0),
            "feedback": content_totals.get("feedback", 0),
            "questions": content_totals.get("questions", 0),
            "acknowledgments": content_totals.get("acknowledgments", 0),
            "other": content_totals.get("other", 0),
        },
        "top_sessions": [
            {
                "session_id": s["session_id"][:12] + "...",
                "agent": s["agent"],
                "human_messages": s["human_messages"],
                "project": _extract_project(s["filepath"]),
            }
            for s in top_sessions
            if s["human_messages"] > 0
        ],
        "project_attention": dict(
            project_attention.most_common(10)
        ),
    }


def _extract_project(filepath):
    """Extract a short project name from session filepath."""
    parts = filepath.split("/")
    for part in parts:
        if part.startswith("-Users-tquick-projects"):
            proj = part.replace("-Users-tquick-projects-", "").replace(
                "-Users-tquick-projects", "general"
            )
            return proj.split("--worktrees")[0]
    return "unknown"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Collect human interaction metrics from Claude Code sessions."
    )
    parser.add_argument(
        "--date",
        default=datetime.now().strftime("%Y-%m-%d"),
        help="Date to collect metrics for (YYYY-MM-DD, default: today)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output file path (default: ~/.claude/daily-summaries/DATE-human-metrics.json)",
    )
    parser.add_argument(
        "--merge-into-summary",
        action="store_true",
        help="Merge results into existing daily summary JSON as 'human_metrics' key",
    )
    parser.add_argument("--verbose", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    target_date = datetime.strptime(args.date, "%Y-%m-%d")
    log(f"Collecting human interaction metrics for {args.date}")

    # Find session files
    sessions = find_sessions(target_date)
    log(f"Found {len(sessions)} candidate session files")

    # Scan each session
    results = []
    for filepath, project_ctx, is_subagent in sessions:
        if args.verbose:
            log(f"Scanning: {filepath}")
        result = scan_session(filepath, target_date, verbose=args.verbose)
        if result:
            result["is_subagent"] = is_subagent
            results.append(result)

    log(f"Sessions with activity on {args.date}: {len(results)}")

    # Aggregate
    metrics = aggregate_metrics(results, target_date)

    # Output
    os.makedirs(SUMMARIES_DIR, exist_ok=True)

    if args.merge_into_summary:
        # Merge into existing daily summary
        summary_path = os.path.join(SUMMARIES_DIR, f"{args.date}.json")
        if os.path.exists(summary_path):
            with open(summary_path, "r") as f:
                summary = json.load(f)
            summary["human_metrics"] = metrics
            with open(summary_path, "w") as f:
                json.dump(summary, f, indent=2)
            log(f"Merged human_metrics into {summary_path}")
        else:
            log(f"No existing summary at {summary_path}, writing standalone")
            out_path = args.output or os.path.join(
                SUMMARIES_DIR, f"{args.date}-human-metrics.json"
            )
            with open(out_path, "w") as f:
                json.dump(metrics, f, indent=2)
            log(f"Wrote standalone metrics to {out_path}")
    else:
        out_path = args.output or os.path.join(
            SUMMARIES_DIR, f"{args.date}-human-metrics.json"
        )
        with open(out_path, "w") as f:
            json.dump(metrics, f, indent=2)
        log(f"Wrote metrics to {out_path}")

    # Also print to stdout for piping
    print(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
