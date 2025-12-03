# GPT Task Manager Integration

This document describes how Base Kanban integrates with the GPT Task Manager plugin, allowing you to view and manage GPT-created tasks in a Kanban board format.

## Overview

When enabled, the GPT Task Manager integration provides:

1. **Shared Task Representation**: GPT Task Manager tasks (individual markdown files with frontmatter) can be displayed as Kanban cards
2. **Lane ↔ Status Mapping**: Moving cards between lanes automatically updates the task's `Status` field in its frontmatter
3. **Bi-directional Sync**: Changes made in either plugin are reflected in both views
4. **Commands**: Create Kanban boards from Epics, Projects, or all tasks

## Configuration

### Enable Integration

1. Open Obsidian Settings → Base Kanban
2. Scroll to "GPT Task Manager Integration"
3. Toggle "Enable GPT Task Manager integration"

### Configure Folders

Set the following paths to match your GPT Task Manager configuration:

| Setting | Default | Description |
|---------|---------|-------------|
| Tasks folder | `500 Plan & Reflect/520 Tasks` | Where GPT Task Manager stores task files |
| Epics folder | `500 Plan & Reflect/510 Epics` | Where epic files are stored |
| Projects folder | `400 Projects` | Where project files are stored |

### Status Values

Configure the status values to match your GPT Task Manager setup:

| Lane | Default Status Value |
|------|---------------------|
| Backlog | `backlog` |
| To Do | `todo` |
| In Progress | `in-progress` |
| Done | `done` |

## Lane ↔ Status Mapping

The default mapping between Kanban lanes and GPT Task Manager status values:

```
Backlog     → backlog
To Do       → todo
In Progress → in-progress
Done        → done
```

When you move a card from one lane to another:
1. The card's position updates in the Kanban board
2. The corresponding task file's `Status:` field is updated
3. The `Updated:` timestamp is refreshed

## Commands

### GPT: Create Kanban board from Epic

Creates a new Kanban board containing all tasks that belong to a specific Epic.

1. Open Command Palette (Cmd/Ctrl + P)
2. Search for "GPT: Create Kanban board from Epic"
3. Select an Epic from the list
4. A new board file is created and opened

### GPT: Create Kanban board from Project

Creates a new Kanban board containing all tasks that belong to a specific Project.

1. Open Command Palette (Cmd/Ctrl + P)
2. Search for "GPT: Create Kanban board from Project"
3. Select a Project from the list
4. A new board file is created and opened

### GPT: Create Kanban board from all tasks

Creates a Kanban board showing all active (non-completed) tasks.

### GPT: Refresh board with latest tasks

Re-syncs the current board with the latest task files.

## Task File Format

GPT Task Manager tasks should have the following frontmatter structure:

```yaml
---
Type: "[[Tasks]]"
Area: "[[Your Area]]"
Goal: "[[Your Goal]]"
Project: "[[Your Project]]"
Epic: "[[Your Epic]]"
Status: backlog
Priority: medium
Due: 
Created: "2025-01-15 10:30"
Updated: "2025-01-15 10:30"
tags:
  - tasks
---
```

The `Status` field is the key field that determines which lane the task appears in.

## Sync Behavior

### When a card is moved between lanes:

1. The card's lane position is updated in the board
2. If the source and destination lanes are different:
   - The task file's `Status` field is updated to match the new lane
   - The `Updated` timestamp is refreshed
3. A notice confirms the status update

### When viewing tasks from GPT Task Manager:

1. Tasks are automatically sorted into lanes based on their `Status` field
2. Within each lane, tasks are sorted by priority (critical → high → medium → low)
3. Task titles are extracted from the `## 🔄 Sync` section's checkbox item

## Best Practices

1. **Use consistent status values**: Ensure GPT Task Manager and Base Kanban use the same status strings
2. **Enable auto-sync**: Set a sync interval in Base Sync settings for automatic updates
3. **Create boards per Epic**: For focused work, create a Kanban board for each active Epic
4. **Archive completed tasks**: Use the "Archive completed cards" command to keep boards tidy

## Troubleshooting

### Tasks not appearing in board

- Verify the tasks folder path is correct
- Check that task files have `Type: "[[Tasks]]"` in frontmatter
- Ensure the Status field value matches one of the configured status values

### Status not updating when moving cards

- Ensure "Update status on card move" is enabled in settings
- Check that the task file has write permissions
- Verify the Status field name matches the setting (default: `Status`)

### Board not syncing

- Enable Base sync in plugin settings
- Set a sync interval (e.g., 5 minutes) for automatic sync
- Use "GPT: Refresh board with latest tasks" for manual sync

