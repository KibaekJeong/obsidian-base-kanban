/**
 * Type definitions for the Kanban plugin with Base task metadata support
 */

// Recurrence pattern types
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type DayOfWeek = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

export interface RecurrencePattern {
	frequency: RecurrenceFrequency;
	interval?: number;              // e.g., every 2 weeks
	daysOfWeek?: DayOfWeek[];       // for weekly: which days
	dayOfMonth?: number;            // for monthly: which day (1-31)
	endDate?: string;               // when recurrence ends (ISO date)
	count?: number;                 // number of occurrences
	_rawPattern?: string;           // original text for round-trip
}

// Subtask interface for checklist items within a card
export interface Subtask {
	id: string;
	text: string;
	completed: boolean;
}

// Base task metadata fields
export interface BaseTaskMetadata {
	progress?: number;          // 0-100 percentage
	project?: string;           // Project name
	priority?: 'low' | 'medium' | 'high' | 'urgent';
	status?: string;            // Custom status
	assignee?: string;
	estimate?: string;          // Time estimate
	spent?: string;             // Time spent
	[key: string]: string | number | undefined;  // Custom fields
}

export interface KanbanCard {
	id: string;
	title: string;
	completed: boolean;
	tags: string[];
	dueDate?: string;
	dueTime?: string;
	recurrence?: RecurrencePattern;  // Recurrence pattern for recurring tasks
	reminderTime?: string;           // Time before due date to remind (e.g., "1h", "30m", "1d")
	notes?: string;                  // Per-card inline notes (stored as > block)
	notePath?: string;               // Path to dedicated note file for this card
	content?: string;                // Multi-line markdown content under the card
	subtasks?: Subtask[];            // Parsed subtasks from content
	metadata: BaseTaskMetadata;
	// Base integration
	baseTaskPath?: string;           // Path to Base task file (for sync)
	baseSyncTime?: number;           // Last sync timestamp (ms)
	// Raw line content for round-trip preservation
	_rawLine?: string;
}

// Lane to Base status mapping
export interface LaneStatusMapping {
	[laneTitle: string]: string;     // Lane title → Base status value
}

// Conflict resolution strategies
export type ConflictResolution = 'local' | 'remote' | 'last-write' | 'prompt';

// Base sync configuration
export interface BaseSyncConfig {
	enabled: boolean;                // Whether sync is enabled
	tasksFolder: string;             // Folder containing Base tasks
	query: string;                   // Dataview-style query for filtering tasks
	statusField: string;             // Field name for status (default: 'status')
	progressField: string;           // Field name for progress (default: 'progress')
	projectField: string;            // Field name for project (default: 'project')
	laneMapping: LaneStatusMapping;  // Lane title → status value mapping
	conflictResolution: ConflictResolution;  // How to handle conflicts
	syncInterval: number;            // Auto-sync interval in minutes (0 = manual only)
	createMissingTasks: boolean;     // Create Base tasks for cards without baseTaskPath
	archiveCompletedTasks: boolean;  // Move completed tasks to archive lane
}

// WIP (Work In Progress) limit configuration
export interface WipLimitConfig {
	limit: number;                   // Maximum cards allowed (0 = no limit)
	warnAt?: number;                 // Show warning when this many cards (optional, defaults to limit)
	blockExceeded: boolean;          // Block adding new cards when exceeded
}

// Lane-specific settings stored in board settings
export interface LaneConfig {
	wipLimit?: WipLimitConfig;       // WIP limit for this lane
	template?: string;               // Lane-specific card template path
}

export interface KanbanLane {
	id: string;
	title: string;
	cards: KanbanCard[];
	// Raw header for round-trip
	_rawHeader?: string;
}

// Board filter state (runtime only, not persisted)
export type DueStateFilter = 'all' | 'overdue' | 'due-today' | 'due-week' | 'no-date' | 'has-date';

export interface BoardFilterState {
	text: string;                    // Free text search
	tags: string[];                  // Filter by tags (OR)
	projects: string[];              // Filter by projects (OR)
	dueState: DueStateFilter;        // Filter by due date state
	showCompleted: boolean;          // Show/hide completed cards
	priority?: string;               // Filter by priority
}

export const DEFAULT_FILTER_STATE: BoardFilterState = {
	text: '',
	tags: [],
	projects: [],
	dueState: 'all',
	showCompleted: true,
};

// Template variable context
export interface TemplateContext {
	title: string;
	date: string;                    // Current date (ISO)
	time: string;                    // Current time (HH:mm)
	datetime: string;                // Current datetime (ISO)
	project?: string;
	lane?: string;
	board?: string;
	dueDate?: string;
	priority?: string;
	tags?: string;
	id: string;
	[key: string]: string | undefined;
}

// Template configuration
export interface CardTemplateConfig {
	path: string;                    // Template file path
	autoCreateNote: boolean;         // Auto-create note from template
	noteFolder?: string;             // Folder for auto-created notes
}

export interface KanbanBoard {
	lanes: KanbanLane[];
	archive: KanbanCard[];
	settings: BoardSettings;
	// Preserve original content sections
	_frontmatter?: string;
	_headerContent?: string;      // Content before first lane
	_footerContent?: string;      // Content after archive/settings
	_preSettingsContent?: string; // Content between last lane and settings block
}

export interface BoardSettings {
	'lane-width'?: string;
	'show-checkboxes'?: boolean;
	'show-card-menu'?: boolean;
	'date-format'?: string;
	'time-format'?: string;
	'archive-with-date'?: boolean;
	'link-date-to-daily-note'?: boolean;
	'show-relative-date'?: boolean;
	'hide-card-count'?: boolean;
	'hide-tags-in-title'?: boolean;
	'hide-date-in-title'?: boolean;
	'hide-metadata-in-title'?: boolean;
	'show-add-list'?: boolean;
	'show-progress'?: boolean;
	'show-project'?: boolean;
	'default-project'?: string;
	'template-path'?: string;
	'new-card-insertion-method'?: 'prepend' | 'append';
	'card-note-template'?: string;   // Template for dedicated card notes
	'card-note-folder'?: string;     // Folder for dedicated card notes
	// Date handling
	'parse-natural-dates'?: boolean;       // Parse natural language dates
	'parse-recurrence'?: boolean;          // Parse recurrence patterns
	'enable-reminders'?: boolean;          // Enable due date reminders
	'reminder-time'?: string;              // Default reminder time before due (e.g., "1h")
	// Card composer
	'show-card-composer'?: boolean;        // Show quick-add composer in lanes
	'composer-position'?: 'top' | 'bottom'; // Position of card composer
	'show-subtasks'?: boolean;             // Show subtasks in card view
	// Base sync (per-board override)
	'base-sync'?: BaseSyncConfig;          // Base sync configuration for this board
	// Filtering
	'show-filter-toolbar'?: boolean;       // Show filter toolbar
	// Lane configs (keyed by lane title or id)
	'lane-configs'?: Record<string, LaneConfig>;
	// Auto-create note on new card
	'auto-create-note'?: boolean;          // Auto-create note for new cards
}

export interface KanbanPluginSettings {
	'new-card-insertion-method': 'prepend' | 'append';
	'prepend-archive-date': boolean;
	'prepend-archive-format': string;
	'date-format': string;
	'time-format': string;
	'date-trigger': string;
	'time-trigger': string;
	'link-date-to-daily-note': boolean;
	'show-relative-date': boolean;
	'hide-tags-in-title': boolean;
	'hide-date-in-title': boolean;
	'hide-metadata-in-title': boolean;
	'default-lane-width': string;
	'show-checkboxes': boolean;
	'show-card-menu': boolean;
	'show-progress': boolean;
	'show-project': boolean;
	'default-project': string;
	'template-path': string;
	'card-note-template': string;    // Template for dedicated card notes
	'card-note-folder': string;      // Folder for dedicated card notes
	// Date handling
	'parse-natural-dates': boolean;        // Parse natural language dates
	'parse-recurrence': boolean;           // Parse recurrence patterns
	'enable-reminders': boolean;           // Enable due date reminders
	'reminder-time': string;               // Default reminder time before due
	'reminder-type': 'notice' | 'system';  // Type of reminder notification
	'date-serialization-format': 'iso' | 'natural';  // How to serialize dates
	// Card composer
	'show-card-composer': boolean;         // Show quick-add composer in lanes
	'composer-position': 'top' | 'bottom'; // Position of card composer
	'show-subtasks': boolean;              // Show subtasks in card view
	// Base sync (global defaults)
	'base-sync': BaseSyncConfig;           // Default Base sync configuration
	// Filtering
	'show-filter-toolbar': boolean;        // Show filter toolbar by default
	// Default WIP limits
	'default-wip-limit': number;           // Default WIP limit (0 = no limit)
	'wip-block-exceeded': boolean;         // Block adding when WIP exceeded
	// Auto-create notes
	'auto-create-note': boolean;           // Auto-create note for new cards
}

export const DEFAULT_BASE_SYNC_CONFIG: BaseSyncConfig = {
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
};

export const DEFAULT_SETTINGS: KanbanPluginSettings = {
	'new-card-insertion-method': 'append',
	'prepend-archive-date': false,
	'prepend-archive-format': 'YYYY-MM-DD',
	'date-format': 'YYYY-MM-DD',
	'time-format': 'HH:mm',
	'date-trigger': '@',
	'time-trigger': '@@',
	'link-date-to-daily-note': false,
	'show-relative-date': false,
	'hide-tags-in-title': false,
	'hide-date-in-title': false,
	'hide-metadata-in-title': false,
	'default-lane-width': '272px',
	'show-checkboxes': true,
	'show-card-menu': true,
	'show-progress': true,
	'show-project': true,
	'default-project': '',
	'template-path': '',
	'card-note-template': '',
	'card-note-folder': '',
	// Date handling
	'parse-natural-dates': true,
	'parse-recurrence': true,
	'enable-reminders': false,
	'reminder-time': '1h',
	'reminder-type': 'notice',
	'date-serialization-format': 'iso',
	// Card composer
	'show-card-composer': true,
	'composer-position': 'bottom',
	'show-subtasks': true,
	// Base sync
	'base-sync': { ...DEFAULT_BASE_SYNC_CONFIG },
	// Filtering
	'show-filter-toolbar': true,
	// WIP limits
	'default-wip-limit': 0,
	'wip-block-exceeded': false,
	// Auto-create notes
	'auto-create-note': false,
};

export const KANBAN_VIEW_TYPE = 'kanban';
export const FRONTMATTER_KEY = 'kanban-plugin';

// Date parsing patterns
export const DATE_PATTERNS = {
	ISO: /\d{4}-\d{2}-\d{2}/,
	FULL_ISO: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
	NATURAL: /(?:today|tomorrow|yesterday|next\s+\w+|last\s+\w+|\d+\s+(?:days?|weeks?|months?)\s+(?:ago|from\s+now))/i,
};

// Natural language date patterns for parsing
export const NATURAL_DATE_PATTERNS = {
	TODAY: /\btoday\b/i,
	TOMORROW: /\btomorrow\b/i,
	YESTERDAY: /\byesterday\b/i,
	NEXT_DAY: /\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
	THIS_DAY: /\bthis\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
	LAST_DAY: /\blast\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
	IN_X_DAYS: /\bin\s+(\d+)\s+days?\b/i,
	IN_X_WEEKS: /\bin\s+(\d+)\s+weeks?\b/i,
	IN_X_MONTHS: /\bin\s+(\d+)\s+months?\b/i,
	X_DAYS_AGO: /\b(\d+)\s+days?\s+ago\b/i,
	NEXT_WEEK: /\bnext\s+week\b/i,
	NEXT_MONTH: /\bnext\s+month\b/i,
	END_OF_WEEK: /\bend\s+of\s+week\b/i,
	END_OF_MONTH: /\bend\s+of\s+month\b/i,
};

// Recurrence pattern matching
export const RECURRENCE_PATTERNS = {
	DAILY: /\b(?:every\s+day|daily)\b/i,
	WEEKLY: /\b(?:every\s+week|weekly)\b/i,
	MONTHLY: /\b(?:every\s+month|monthly)\b/i,
	YEARLY: /\b(?:every\s+year|yearly|annually)\b/i,
	EVERY_X_DAYS: /\bevery\s+(\d+)\s+days?\b/i,
	EVERY_X_WEEKS: /\bevery\s+(\d+)\s+weeks?\b/i,
	EVERY_X_MONTHS: /\bevery\s+(\d+)\s+months?\b/i,
	EVERY_DAY_OF_WEEK: /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s*,\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday))*\b/i,
	WEEKDAYS: /\b(?:every\s+weekday|weekdays)\b/i,
	WEEKENDS: /\b(?:every\s+weekend|weekends)\b/i,
};

// Day name to index mapping
export const DAY_NAMES: Record<string, number> = {
	sunday: 0,
	monday: 1,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: 6,
};

export const DAY_NAMES_REVERSE: Record<number, DayOfWeek> = {
	0: 'sunday',
	1: 'monday',
	2: 'tuesday',
	3: 'wednesday',
	4: 'thursday',
	5: 'friday',
	6: 'saturday',
};

// Metadata key patterns for Base integration
export const METADATA_KEYS = [
	'progress',
	'project', 
	'priority',
	'status',
	'assignee',
	'estimate',
	'spent',
];
