# Base Kanban Audit Report

This document summarizes the audit of `obsidian-base-kanban` against the Kanban Plus (`geetduggal/obsidian-kanban`) feature set and identifies potential issues for hardening.

---

## 1. Feature Matrix

| Feature Category | Kanban Plus Feature | obsidian-base-kanban Status | Notes |
|------------------|---------------------|----------------------------|-------|
| **Core Board** | Create kanban board (ribbon, folder menu, command) | ✅ Implemented | `main.ts` lines 48-50, 91-95, 217-232 |
| | Toggle kanban/markdown view | ✅ Implemented | Command `toggle-kanban-view`, lines 98-122 |
| | Frontmatter detection (`kanban-plugin: basic`) | ✅ Implemented | `parser.ts` `hasFrontmatterKey`, `FRONTMATTER_KEY` |
| | Monkey-patch to auto-open kanban files | ✅ Implemented | `main.ts` `registerMonkeyPatch()` lines 271-311 |
| | Convert empty note to kanban | ✅ Implemented | Command `convert-to-kanban`, lines 137-156 |
| **Lanes** | Add/delete lanes | ✅ Implemented | `KanbanView.ts` `addLane()`, `deleteLane()` |
| | Rename lanes (inline edit) | ✅ Implemented | `renderLane()` contentEditable title |
| | Drag-and-drop lane reordering | ✅ Implemented | `setupLaneSortable()` with SortableJS |
| | Lane card count display | ✅ Implemented | Controlled by `hide-card-count` setting |
| | WIP limits per lane | ✅ Implemented | `getLaneWipConfig()`, `WipLimitModal`, lane-configs |
| **Cards** | Add/delete/archive cards | ✅ Implemented | `addCard()`, `deleteCard()`, `archiveCard()` |
| | Inline title editing | ✅ Implemented | contentEditable in `renderCard()` |
| | Drag-and-drop between lanes | ✅ Implemented | `setupCardSortable()` group: 'cards' |
| | Completion checkbox | ✅ Implemented | Controlled by `show-checkboxes` setting |
| | Card menu (edit, move, archive, etc.) | ✅ Implemented | `showCardMenu()` with submenu for lane moves |
| | Quick-add composer | ✅ Implemented | `renderCardComposer()`, position top/bottom |
| | Card templates | ✅ Implemented | `addCardFromTemplate()`, `createCardFromTemplate()` |
| **Metadata** | Tags (`#tag`) | ✅ Implemented | Parsed in `parseTags()`, displayed as pills |
| | Due date (`@YYYY-MM-DD`) | ✅ Implemented | `parseDate()`, metadata pills |
| | Due time (`@@HH:mm` or `@...THH:mm`) | ✅ Implemented | Parsed and displayed |
| | Progress (`[progress::N%]`) | ✅ Implemented | `parseInlineMetadata()`, progress pill |
| | Project (`[project::name]`) | ✅ Implemented | Parsed, displayed, filterable |
| | Priority (`low/medium/high/urgent`) | ✅ Implemented | Priority pill with color coding |
| | Custom metadata (`[key::value]`) | ✅ Implemented | Generic metadata parsing |
| **Natural Language** | Parse "today", "tomorrow", "next Monday" | ✅ Implemented | `parseNaturalDate()` in parser.ts |
| | Recurrence patterns ("daily", "every 2 weeks") | ✅ Implemented | `parseRecurrence()`, `RecurrencePattern` type |
| | Relative date display ("In 3 days") | ✅ Implemented | `formatRelativeDate()` |
| **Reminders** | Due date reminders | ✅ Implemented | `checkReminders()`, `startReminderCheck()` |
| | Per-card reminder time (`[remind::1h]`) | ✅ Implemented | `reminderTime` field parsed |
| | System vs in-app notifications | ✅ Implemented | `reminder-type` setting |
| **Subtasks** | Subtask checkboxes in cards | ✅ Implemented | `renderSubtasks()`, `Subtask` type |
| | Subtask progress indicator | ✅ Implemented | Progress bar in subtasks section |
| | Toggle subtask completion | ✅ Implemented | Checkbox change handler |
| **Card Notes** | Inline notes (`> block`) | ✅ Implemented | Parsed from content, `notes` field |
| | Dedicated note file per card | ✅ Implemented | `notePath`, `createCardNote()`, `openCardNote()` |
| | Link to existing note | ✅ Implemented | `linkToExistingNote()`, `NoteLinkModal` |
| | Card note templates | ✅ Implemented | `card-note-template` setting, variable substitution |
| | Sync card metadata to/from note | ✅ Implemented | `syncCardToNote()`, `syncCardFromNote()` |
| **Filtering** | Filter toolbar | ✅ Implemented | `renderFilterToolbar()`, `show-filter-toolbar` |
| | Text search | ✅ Implemented | `filterState.text`, searches title/notes/content |
| | Tag filter | ✅ Implemented | `showTagFilterMenu()` |
| | Project filter | ✅ Implemented | `showProjectFilterMenu()` |
| | Due date filter (overdue, today, week) | ✅ Implemented | `showDueFilterMenu()`, `DueStateFilter` |
| | Show/hide completed | ✅ Implemented | `filterState.showCompleted` |
| **Archive** | Archive lane | ✅ Implemented | `## Archive` section in parser |
| | Archive completed cards command | ✅ Implemented | `archiveCompletedCards()` |
| | Prepend archive date | ✅ Implemented | `prepend-archive-date` setting |
| **Settings** | Global plugin settings | ✅ Implemented | `KanbanSettingTab` |
| | Per-board settings | ✅ Implemented | `BoardSettings`, `BoardSettingsModal` |
| | Settings inheritance (global → board) | ✅ Implemented | `getSetting()` method |
| **Base Sync** | Enable/disable sync | ✅ Implemented | `base-sync.enabled` |
| | Tasks folder configuration | ✅ Implemented | `base-sync.tasksFolder` |
| | Lane → status mapping | ✅ Implemented | `laneMapping` with UI for editing |
| | Sync on card move | ✅ Implemented | `syncCardStatusToBase()` |
| | Background sync interval | ✅ Implemented | `startBackgroundSync()`, `syncInterval` |
| | Conflict resolution (local/remote/prompt) | ✅ Implemented | `ConflictResolutionModal`, strategies |
| | Create Base task for card | ✅ Implemented | `createBaseTaskForCard()` |
| | Link card to existing task | ✅ Implemented | `linkCardToBaseTask()`, `BaseTaskPickerModal` |
| | Sync progress/project to Base | ✅ Implemented | `syncProgress()`, `syncProject()` |
| **Cross-File Workflows** | Associated files | ❌ Missing | Not implemented |
| | Move card to another file | ❌ Missing | Not implemented |
| | Move list to another file | ❌ Missing | Not implemented |
| **Calendar Integration** | Copy to Full Calendar | ❌ Missing | Not implemented |
| | Hashtag-based calendar colors | ❌ Missing | Not implemented |
| | Calendar picker modal | ❌ Missing | Not implemented |

---

## 2. Core Kanban Behavior Validation

### 2.1 Board Lifecycle

**Creating a board:**
- Ribbon icon calls `createNewKanban()` (line 48-50)
- Folder context menu adds "New kanban board" option (lines 223-231)
- Command `create-new-kanban-board` (lines 91-95)
- `createNewKanban()` uses `(this.app.fileManager as any).createNewMarkdownFile()` which is a private API but widely used

**Potential issue:** The cast `(this.app.fileManager as any)` relies on an undocumented API. If Obsidian changes this, board creation will break.

**Frontmatter:**
- `BASIC_FRONTMATTER` constant: `---\nkanban-plugin: basic\n---\n\n`
- `ensureKanbanFrontmatter()` adds the key if missing
- Detection via `hasFrontmatterKey()` checks for `kanban-plugin` in frontmatter

### 2.2 View Switching and Monkey Patching

**View registration:**
```typescript
this.registerView(KANBAN_VIEW_TYPE, (leaf) => new KanbanView(leaf, this));
```

**Monkey patch analysis (`registerMonkeyPatch`):**
- Wraps `WorkspaceLeaf.prototype.detach` to clean up `kanbanFileModes`
- Wraps `WorkspaceLeaf.prototype.setViewState` to intercept markdown views for kanban files

**Potential issues:**
1. `(this as any).id` on WorkspaceLeaf - leaf IDs are not officially part of the API
2. `self.kanbanFileModes[(this as any).id || stateFile]` - fallback to file path works but mixing ID and path as keys is fragile
3. No cleanup of `kanbanFileModes` entries when files are deleted/renamed

**Toggle command:**
- Correctly switches between `KanbanView` and `MarkdownView`
- Uses `popstate: true` in ViewState to handle history

### 2.3 Drag-and-Drop Operations

**Lane sortable (`setupLaneSortable`):**
- Guards: `if (oldIndex === undefined || newIndex === undefined) return;`
- Guard: `if (newIndex >= this.board.lanes.length) return;`
- Correctly splices and re-inserts lane
- Calls `requestSave()` and `render()`

**Card sortable (`setupCardSortable`):**
- Uses `group: 'cards'` for cross-lane dragging
- Retrieves lane IDs from data attributes
- Guards: `if (!cardId || !fromLaneId || !toLaneId) return;`
- Guards: `if (!fromLane || !toLane) return;`
- Guards: `if (cardIndex === -1) return;`

**Potential issue:** If a lane is deleted while a drag is in progress, the `toLane` lookup could fail. The guards handle this gracefully by returning early.

### 2.4 Parser Round-Tripping

**Parsing (`parseKanbanBoard`):**
- Extracts frontmatter, preserves it in `_frontmatter`
- Finds lane sections by `## ` headers
- Parses cards with checkbox format `- [ ]` or `- [x]`
- Extracts IDs from `^id-marker` at end of lines
- Preserves header/footer content
- Handles archive section specially

**Serialization (`serializeKanbanBoard`):**
- Reconstructs frontmatter with `ensureKanbanFrontmatter()`
- Serializes lanes with IDs
- Serializes archive section
- Preserves settings block
- Preserves footer content

**Potential issues:**
1. `generateId()` uses `Math.random()` which could theoretically collide, but the timestamp suffix makes this extremely unlikely
2. If a card title contains `^` followed by word characters at the end, it could be misinterpreted as an ID marker
3. Empty boards (no lanes) are handled - `createEmptyBoard()` provides defaults

**Graceful handling:**
- `parseCard` returns `{ card: null, endIndex: startIndex }` if line doesn't match
- `parseLane` returns `null` if header doesn't match
- Try/catch blocks in reminder checking silently continue on parse errors

---

## 3. Base Sync Integration Validation

### 3.1 Configuration Flow

**Settings wiring (`KanbanSettingTab`):**
- All `base-sync` sub-settings are properly bound to `this.plugin.settings['base-sync']`
- Lane mapping UI allows add/edit/delete of mappings
- Conditional rendering: sync settings only shown when `enabled: true`

**Defaults (`DEFAULT_BASE_SYNC_CONFIG`):**
```typescript
{
  enabled: false,
  tasksFolder: 'Tasks',
  query: '',
  statusField: 'status',
  progressField: 'progress',
  projectField: 'project',
  laneMapping: {},
  conflictResolution: 'prompt',
  syncInterval: 0,
  createMissingTasks: false,
  archiveCompletedTasks: false,
}
```

### 3.2 Card-Level Operations

**`manualSync()`:**
- Simply calls `performBackgroundSync()` - no additional guards needed

**`linkCardToBaseTask()`:**
- Guards: `if (!config.enabled)` shows Notice and returns
- Opens `BaseTaskPickerModal` with tasks folder
- Updates `baseTaskPath` and `baseSyncTime` on selection

**`createBaseTaskForCard()`:**
- Guards: `if (!config.enabled)` shows Notice and returns
- Calls `baseSyncService.createBaseTask()`
- Handles null return with Notice

**`syncCardStatusToBase()`:**
- Guards: `if (!syncConfig.enabled) return;`
- Only syncs if `card.baseTaskPath` exists
- Optionally creates task if `createMissingTasks` is true

### 3.3 Sync Engine Behavior

**`BaseSyncService.syncFromBase()`:**
- Concurrency guard: `if (this.syncInProgress)` returns early with error
- Sets `syncInProgress = true` at start, `false` in finally block
- Queries tasks from folder
- Builds map of existing cards by `baseTaskPath`
- Updates existing cards or creates new ones
- Handles conflicts via callback

**Lane mapping:**
- `findLaneForTask()` does reverse lookup from status to lane
- Falls back to first lane if no mapping found
- Cards without status go to first lane

**Potential issues:**
1. If tasks folder doesn't exist, `queryBaseTasks()` logs warning and returns empty array - safe
2. If all lanes are deleted, `findLaneForTask()` returns `null` and card is not created
3. `updateCardFromTask()` can move cards between lanes during sync, which could be surprising to users

### 3.4 Error Surfaces and UX

**`ConflictResolutionModal`:**
- Shows local vs remote values
- Provides Keep Local, Use Remote, Skip buttons
- Properly closes modal after selection

**`BaseTaskPickerModal`:**
- Handles empty tasks folder gracefully
- Shows "No tasks found" message
- Filter input for searching

**Sync status:**
- `updateSyncStatus()` shows syncing/success/error states
- Success auto-hides after 2 seconds
- Errors persist until next action

**Notices:**
- `new Notice()` used for user-facing messages
- Error paths show notices (e.g., "Base sync is not enabled")

---

## 4. Identified Issues and Recommendations

### 4.1 High Priority Issues - FIXED

| Issue | Location | Status |
|-------|----------|--------|
| Private API usage for file creation | `main.ts:351-400` | ✅ FIXED - Added try/catch with fallback to `vault.create()` |
| Leaf ID assumption | `main.ts` various | ✅ FIXED - Now uses file path as primary key consistently |
| No file rename handling | `kanbanFileModes` | ✅ FIXED - Added `vault.on('rename')` and `vault.on('delete')` handlers |
| Notification API check | `main.ts:495` | ✅ OK - Already checks `'Notification' in window` |

### 4.2 Medium Priority Issues - FIXED

| Issue | Location | Status |
|-------|----------|--------|
| Empty board sync | `BaseSyncService:376-382` | ✅ FIXED - Added guard for boards with no lanes |
| Empty task title | `BaseSyncService:279-283` | ✅ FIXED - Handle empty titles with "Untitled Task" fallback |
| Folder creation race | `BaseSyncService:272-286` | ✅ FIXED - Added retry logic for folder creation |

### 4.3 Remaining Low Priority (Acceptable as-is)

| Issue | Location | Notes |
|-------|----------|-------|
| Card ID in title collision | `parser.ts:601-609` | Low risk - requires `^` prefix at end of line |
| Empty board state | `KanbanView.ts` | OK - `createEmptyBoard()` handles this |
| Sync during board edit | `BaseSyncService` | OK - Concurrency guard exists |
| Missing tasks folder | `BaseSyncService:117-120` | OK - Logs warning, returns empty |
| Lane deleted during drag | `KanbanView.ts` | OK - Guards return early |
| Math.random() for IDs | `parser.ts:63-65` | OK - Timestamp suffix makes collision extremely unlikely |
| Any casts on workspace | Various | OK - Type assertions are common in Obsidian plugins |
| Reminder check on large vaults | `main.ts:395-420` | Consider caching if performance is an issue |

### 4.4 Applied Code Changes

1. **File rename and delete handling (main.ts):**
```typescript
// Added in onload()
this.registerEvent(
  this.app.vault.on('rename', (file, oldPath) => {
    if (this.kanbanFileModes[oldPath]) {
      this.kanbanFileModes[file.path] = this.kanbanFileModes[oldPath];
      delete this.kanbanFileModes[oldPath];
    }
  })
);
this.registerEvent(
  this.app.vault.on('delete', (file) => {
    if (this.kanbanFileModes[file.path]) {
      delete this.kanbanFileModes[file.path];
    }
  })
);
```

2. **Safer file creation with fallback (main.ts:351-400):**
- Primary: Uses internal `createNewMarkdownFile` API
- Fallback: Direct `vault.create()` with manual naming conflict handling

3. **Consistent file path keys (main.ts):**
- Removed all `(leaf as any).id` references
- Now uses `file.path` consistently for `kanbanFileModes` keys

4. **Base sync guards (BaseSync.ts):**
- Added guard for syncing to boards with no lanes
- Added retry logic for folder creation
- Added fallback for empty task titles

### 4.5 Original Recommended Code (for reference)

The following changes were recommended and have been applied:

1. **Add file rename handling:** ✅ Applied
```typescript
// In onload()
this.registerEvent(
  this.app.vault.on('rename', (file, oldPath) => {
    if (this.kanbanFileModes[oldPath]) {
      this.kanbanFileModes[file.path] = this.kanbanFileModes[oldPath];
      delete this.kanbanFileModes[oldPath];
    }
  })
);
```

2. **Safer file creation with fallback:** ✅ Applied
```typescript
async createNewKanban(folder?: TFolder): Promise<void> {
  // ... existing code ...
  try {
    const kanban: TFile = await (this.app.fileManager as any).createNewMarkdownFile(
      targetFolder,
      'Untitled Kanban'
    );
    // ... rest of method
  } catch (error) {
    // Fallback to direct vault.create
    try {
      const path = `${targetFolder.path}/Untitled Kanban.md`;
      const kanban = await this.app.vault.create(path, BASIC_FRONTMATTER);
      // ... rest of method
    } catch (fallbackError) {
      console.error('Error creating kanban board:', fallbackError);
      new Notice('Error creating Kanban board');
    }
  }
}
```

3. **Simplify kanbanFileModes key management:**
```typescript
// Use only file path as key, not leaf ID
private getFileModeKey(leaf: WorkspaceLeaf): string {
  const state = leaf.view?.getState();
  return state?.file as string || '';
}
```

---

## 5. Missing Features vs Kanban Plus

### 5.1 Cross-File Workflows (Not Implemented)

**Associated Files:**
- Kanban Plus allows linking multiple kanban files together
- Cards can be moved between associated files
- Board settings include "Associated Files" section

**Implementation path:**
1. Add `associatedFiles: string[]` to `BoardSettings`
2. Add UI in `BoardSettingsModal` for file picker
3. Add context menu action "Move to file..." with submenu
4. Implement `moveCardToFile(card, targetPath, targetLane)` method

**Move List to File:**
- Entire lanes can be moved to another kanban file
- Options to merge into existing lane or keep separate

**Implementation path:**
1. Add lane menu action "Move list to file..."
2. Show file picker modal
3. Implement `moveLaneToFile(lane, targetPath, mergeOption)` method

### 5.2 Calendar Integration (Not Implemented)

**Copy to Full Calendar:**
- Context menu action to create calendar event from card
- Calendar picker modal with color indicators
- Option to add calendar hashtag to card

**Implementation path:**
1. Detect Full Calendar plugin via `app.plugins.plugins['obsidian-full-calendar']`
2. Create calendar picker modal
3. Generate event file in Full Calendar format
4. Optionally update card with hashtag

**Hashtag-based Calendar Colors:**
- Cards display background color based on hashtags matching calendar names
- Dynamic color resolution from Full Calendar plugin

**Implementation path:**
1. Query Full Calendar for calendar list and colors
2. In `renderCard()`, check card tags against calendar names
3. Apply background color CSS variable

---

## 6. Conclusion

The `obsidian-base-kanban` plugin implements the vast majority of core Kanban functionality and Base sync features. The main gaps are:

1. **Cross-file workflows** - Associated files, move card/list between files
2. **Calendar integration** - Full Calendar sync, hashtag colors

### Applied Fixes

The following high-priority issues have been addressed in this audit:

1. ✅ **File rename/delete handling** - Added `vault.on('rename')` and `vault.on('delete')` event handlers to keep `kanbanFileModes` in sync
2. ✅ **Fallback for private API** - `createNewKanban()` now has a fallback to `vault.create()` if the internal API fails
3. ✅ **Consistent file path keys** - Removed leaf ID fallbacks, now uses file paths consistently
4. ✅ **Base sync guards** - Added guards for empty boards, empty titles, and folder creation race conditions

### Remaining Work (Out of Scope)

The following features from Kanban Plus are not implemented and would require significant new development:

- **Associated files** - Linking multiple kanban boards together
- **Cross-file card/list moves** - Moving cards or entire lanes between boards
- **Full Calendar integration** - Copy to calendar, hashtag-based colors

These advanced features can be added in future iterations if needed.

### Testing Recommendations

Before deploying, test the following scenarios:

1. Create a new kanban board via ribbon, folder menu, and command
2. Rename and delete kanban files while they're open
3. Toggle between kanban and markdown view
4. Drag cards between lanes and reorder lanes
5. Enable Base sync and move cards between lanes
6. Sync with a non-existent tasks folder (should create it)
7. Create a Base task for a card with an empty title

