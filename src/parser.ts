/**
 * Enhanced Markdown parser and serializer for Kanban boards
 * 
 * Features:
 * - Preserves all frontmatter (only ensures kanban-plugin key exists)
 * - Preserves non-kanban content (header, footer sections)
 * - Stable IDs (preserves existing, generates new only when needed)
 * - Base task metadata support (progress, project, tags, due date, etc.)
 * - Per-card notes via > block syntax
 * - Round-trip safe serialization
 * 
 * Board format:
 * ---
 * kanban-plugin: basic
 * other-frontmatter: preserved
 * ---
 * 
 * Optional header content here (preserved)
 * 
 * ## Lane Title
 * 
 * - [ ] Card title #tag @2024-01-15 [progress::50%] [project::Alpha]
 *   > Card notes can span
 *   > multiple lines
 * - [x] Completed card ^card-id-123
 * 
 * ## Another Lane ^lane-id-456
 * 
 * ## Archive
 * 
 * - [x] Archived card
 * 
 * %% kanban:settings
 * ```json
 * { "lane-width": "300px" }
 * ```
 * %%
 * 
 * Optional footer content here (preserved)
 */

import { 
	KanbanBoard, 
	KanbanCard, 
	KanbanLane, 
	BoardSettings, 
	BaseTaskMetadata,
	RecurrencePattern,
	RecurrenceFrequency,
	DayOfWeek,
	Subtask,
	TemplateContext,
	FRONTMATTER_KEY,
	DATE_PATTERNS,
	METADATA_KEYS,
	NATURAL_DATE_PATTERNS,
	RECURRENCE_PATTERNS,
	DAY_NAMES,
	DAY_NAMES_REVERSE,
} from './types';

// ID generation with collision avoidance
function generateId(): string {
	return Math.random().toString(36).substring(2, 11) + Date.now().toString(36).slice(-4);
}

// ============ Template Variable Substitution ============

// Input options for creating template context
export interface TemplateContextOptions {
	title?: string;
	project?: string;
	lane?: string;
	board?: string;
	dueDate?: string;
	priority?: string;
	tags?: string[] | string;       // Accept both array and string
	customVars?: Record<string, string>;
}

/**
 * Create a template context with current values
 */
export function createTemplateContext(options: TemplateContextOptions = {}): TemplateContext {
	const now = new Date();
	const id = generateId();
	
	// Handle tags - convert array to string if needed
	let tagsStr: string | undefined;
	if (options.tags) {
		tagsStr = Array.isArray(options.tags) ? options.tags.join(', ') : options.tags;
	}
	
	return {
		title: options.title || '',
		date: formatISODate(now),
		time: now.toTimeString().slice(0, 5),
		datetime: now.toISOString(),
		project: options.project,
		lane: options.lane,
		board: options.board,
		dueDate: options.dueDate,
		priority: options.priority,
		tags: tagsStr,
		id,
		...options.customVars,
	};
}

/**
 * Substitute template variables in content
 * Supports: {{variable}}, {{variable|default}}, {{date:format}}
 */
export function substituteTemplateVariables(content: string, context: TemplateContext): string {
	// Match {{variable}}, {{variable|default}}, or {{date:format}}
	return content.replace(/\{\{([^}]+)\}\}/g, (match, expr) => {
		const trimmed = expr.trim();
		
		// Check for date formatting: {{date:YYYY-MM-DD}}
		if (trimmed.startsWith('date:')) {
			const format = trimmed.slice(5);
			return formatDateWithPattern(new Date(), format);
		}
		
		// Check for default value: {{variable|default}}
		if (trimmed.includes('|')) {
			const [varName, defaultValue] = trimmed.split('|').map((s: string) => s.trim());
			const value = context[varName];
			return value !== undefined && value !== '' ? String(value) : defaultValue;
		}
		
		// Simple variable substitution
		const value = context[trimmed];
		return value !== undefined ? String(value) : match; // Keep original if not found
	});
}

/**
 * Format date with a pattern (simple version)
 */
function formatDateWithPattern(date: Date, pattern: string): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	const seconds = String(date.getSeconds()).padStart(2, '0');
	
	const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
	const dayNamesShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
		'July', 'August', 'September', 'October', 'November', 'December'];
	const monthNamesShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
		'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	
	return pattern
		.replace(/YYYY/g, String(year))
		.replace(/YY/g, String(year).slice(-2))
		.replace(/MMMM/g, monthNames[date.getMonth()])
		.replace(/MMM/g, monthNamesShort[date.getMonth()])
		.replace(/MM/g, month)
		.replace(/M/g, String(date.getMonth() + 1))
		.replace(/DDDD/g, dayNames[date.getDay()])
		.replace(/DDD/g, dayNamesShort[date.getDay()])
		.replace(/DD/g, day)
		.replace(/D/g, String(date.getDate()))
		.replace(/HH/g, hours)
		.replace(/H/g, String(date.getHours()))
		.replace(/mm/g, minutes)
		.replace(/m/g, String(date.getMinutes()))
		.replace(/ss/g, seconds)
		.replace(/s/g, String(date.getSeconds()));
}

// ============ Natural Language Date Parsing ============

/**
 * Parse natural language date expression to ISO date string
 */
export function parseNaturalDate(text: string, referenceDate: Date = new Date()): { date: string | null; matched: string | null } {
	const today = new Date(referenceDate);
	today.setHours(0, 0, 0, 0);
	
	// Today
	const todayMatch = text.match(NATURAL_DATE_PATTERNS.TODAY);
	if (todayMatch) {
		return { date: formatISODate(today), matched: todayMatch[0] };
	}
	
	// Tomorrow
	const tomorrowMatch = text.match(NATURAL_DATE_PATTERNS.TOMORROW);
	if (tomorrowMatch) {
		const tomorrow = new Date(today);
		tomorrow.setDate(tomorrow.getDate() + 1);
		return { date: formatISODate(tomorrow), matched: tomorrowMatch[0] };
	}
	
	// Yesterday
	const yesterdayMatch = text.match(NATURAL_DATE_PATTERNS.YESTERDAY);
	if (yesterdayMatch) {
		const yesterday = new Date(today);
		yesterday.setDate(yesterday.getDate() - 1);
		return { date: formatISODate(yesterday), matched: yesterdayMatch[0] };
	}
	
	// Next [day of week]
	const nextDayMatch = text.match(NATURAL_DATE_PATTERNS.NEXT_DAY);
	if (nextDayMatch) {
		const dayName = nextDayMatch[1].toLowerCase();
		const targetDay = DAY_NAMES[dayName];
		if (targetDay !== undefined) {
			const date = getNextDayOfWeek(today, targetDay, true);
			return { date: formatISODate(date), matched: nextDayMatch[0] };
		}
	}
	
	// This [day of week]
	const thisDayMatch = text.match(NATURAL_DATE_PATTERNS.THIS_DAY);
	if (thisDayMatch) {
		const dayName = thisDayMatch[1].toLowerCase();
		const targetDay = DAY_NAMES[dayName];
		if (targetDay !== undefined) {
			const date = getNextDayOfWeek(today, targetDay, false);
			return { date: formatISODate(date), matched: thisDayMatch[0] };
		}
	}
	
	// Last [day of week]
	const lastDayMatch = text.match(NATURAL_DATE_PATTERNS.LAST_DAY);
	if (lastDayMatch) {
		const dayName = lastDayMatch[1].toLowerCase();
		const targetDay = DAY_NAMES[dayName];
		if (targetDay !== undefined) {
			const date = getLastDayOfWeek(today, targetDay);
			return { date: formatISODate(date), matched: lastDayMatch[0] };
		}
	}
	
	// In X days
	const inDaysMatch = text.match(NATURAL_DATE_PATTERNS.IN_X_DAYS);
	if (inDaysMatch) {
		const days = parseInt(inDaysMatch[1], 10);
		const date = new Date(today);
		date.setDate(date.getDate() + days);
		return { date: formatISODate(date), matched: inDaysMatch[0] };
	}
	
	// In X weeks
	const inWeeksMatch = text.match(NATURAL_DATE_PATTERNS.IN_X_WEEKS);
	if (inWeeksMatch) {
		const weeks = parseInt(inWeeksMatch[1], 10);
		const date = new Date(today);
		date.setDate(date.getDate() + weeks * 7);
		return { date: formatISODate(date), matched: inWeeksMatch[0] };
	}
	
	// In X months
	const inMonthsMatch = text.match(NATURAL_DATE_PATTERNS.IN_X_MONTHS);
	if (inMonthsMatch) {
		const months = parseInt(inMonthsMatch[1], 10);
		const date = new Date(today);
		date.setMonth(date.getMonth() + months);
		return { date: formatISODate(date), matched: inMonthsMatch[0] };
	}
	
	// X days ago
	const daysAgoMatch = text.match(NATURAL_DATE_PATTERNS.X_DAYS_AGO);
	if (daysAgoMatch) {
		const days = parseInt(daysAgoMatch[1], 10);
		const date = new Date(today);
		date.setDate(date.getDate() - days);
		return { date: formatISODate(date), matched: daysAgoMatch[0] };
	}
	
	// Next week (next Monday)
	const nextWeekMatch = text.match(NATURAL_DATE_PATTERNS.NEXT_WEEK);
	if (nextWeekMatch) {
		const date = getNextDayOfWeek(today, 1, true); // Monday
		return { date: formatISODate(date), matched: nextWeekMatch[0] };
	}
	
	// Next month (1st of next month)
	const nextMonthMatch = text.match(NATURAL_DATE_PATTERNS.NEXT_MONTH);
	if (nextMonthMatch) {
		const date = new Date(today);
		date.setMonth(date.getMonth() + 1);
		date.setDate(1);
		return { date: formatISODate(date), matched: nextMonthMatch[0] };
	}
	
	// End of week (Sunday)
	const endOfWeekMatch = text.match(NATURAL_DATE_PATTERNS.END_OF_WEEK);
	if (endOfWeekMatch) {
		const date = getNextDayOfWeek(today, 0, false); // Sunday
		if (date.getTime() === today.getTime() && today.getDay() !== 0) {
			date.setDate(date.getDate() + 7);
		}
		return { date: formatISODate(date), matched: endOfWeekMatch[0] };
	}
	
	// End of month
	const endOfMonthMatch = text.match(NATURAL_DATE_PATTERNS.END_OF_MONTH);
	if (endOfMonthMatch) {
		const date = new Date(today.getFullYear(), today.getMonth() + 1, 0);
		return { date: formatISODate(date), matched: endOfMonthMatch[0] };
	}
	
	return { date: null, matched: null };
}

// Helper: Get next occurrence of a day of week
function getNextDayOfWeek(from: Date, targetDay: number, skipThisWeek: boolean): Date {
	const date = new Date(from);
	const currentDay = date.getDay();
	let daysToAdd = targetDay - currentDay;
	
	if (daysToAdd <= 0 || (skipThisWeek && daysToAdd < 7)) {
		daysToAdd += 7;
	}
	
	date.setDate(date.getDate() + daysToAdd);
	return date;
}

// Helper: Get last occurrence of a day of week
function getLastDayOfWeek(from: Date, targetDay: number): Date {
	const date = new Date(from);
	const currentDay = date.getDay();
	let daysToSubtract = currentDay - targetDay;
	
	if (daysToSubtract <= 0) {
		daysToSubtract += 7;
	}
	
	date.setDate(date.getDate() - daysToSubtract);
	return date;
}

// Helper: Format date to ISO string (YYYY-MM-DD)
function formatISODate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

// ============ Recurrence Pattern Parsing ============

/**
 * Parse recurrence pattern from text
 */
export function parseRecurrence(text: string): { pattern: RecurrencePattern | null; matched: string | null } {
	// Daily
	const dailyMatch = text.match(RECURRENCE_PATTERNS.DAILY);
	if (dailyMatch) {
		return {
			pattern: { frequency: 'daily', _rawPattern: dailyMatch[0] },
			matched: dailyMatch[0]
		};
	}
	
	// Weekly
	const weeklyMatch = text.match(RECURRENCE_PATTERNS.WEEKLY);
	if (weeklyMatch) {
		return {
			pattern: { frequency: 'weekly', _rawPattern: weeklyMatch[0] },
			matched: weeklyMatch[0]
		};
	}
	
	// Monthly
	const monthlyMatch = text.match(RECURRENCE_PATTERNS.MONTHLY);
	if (monthlyMatch) {
		return {
			pattern: { frequency: 'monthly', _rawPattern: monthlyMatch[0] },
			matched: monthlyMatch[0]
		};
	}
	
	// Yearly
	const yearlyMatch = text.match(RECURRENCE_PATTERNS.YEARLY);
	if (yearlyMatch) {
		return {
			pattern: { frequency: 'yearly', _rawPattern: yearlyMatch[0] },
			matched: yearlyMatch[0]
		};
	}
	
	// Every X days
	const everyXDaysMatch = text.match(RECURRENCE_PATTERNS.EVERY_X_DAYS);
	if (everyXDaysMatch) {
		return {
			pattern: {
				frequency: 'daily',
				interval: parseInt(everyXDaysMatch[1], 10),
				_rawPattern: everyXDaysMatch[0]
			},
			matched: everyXDaysMatch[0]
		};
	}
	
	// Every X weeks
	const everyXWeeksMatch = text.match(RECURRENCE_PATTERNS.EVERY_X_WEEKS);
	if (everyXWeeksMatch) {
		return {
			pattern: {
				frequency: 'weekly',
				interval: parseInt(everyXWeeksMatch[1], 10),
				_rawPattern: everyXWeeksMatch[0]
			},
			matched: everyXWeeksMatch[0]
		};
	}
	
	// Every X months
	const everyXMonthsMatch = text.match(RECURRENCE_PATTERNS.EVERY_X_MONTHS);
	if (everyXMonthsMatch) {
		return {
			pattern: {
				frequency: 'monthly',
				interval: parseInt(everyXMonthsMatch[1], 10),
				_rawPattern: everyXMonthsMatch[0]
			},
			matched: everyXMonthsMatch[0]
		};
	}
	
	// Every [day(s) of week] - e.g., "every Monday", "every Monday, Wednesday, Friday"
	const everyDayMatch = text.match(RECURRENCE_PATTERNS.EVERY_DAY_OF_WEEK);
	if (everyDayMatch) {
		// Extract all day names from the match
		const dayNames = everyDayMatch[0].toLowerCase().match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g) || [];
		const daysOfWeek = dayNames.map(d => d as DayOfWeek);
		
		return {
			pattern: {
				frequency: 'weekly',
				daysOfWeek,
				_rawPattern: everyDayMatch[0]
			},
			matched: everyDayMatch[0]
		};
	}
	
	// Weekdays
	const weekdaysMatch = text.match(RECURRENCE_PATTERNS.WEEKDAYS);
	if (weekdaysMatch) {
		return {
			pattern: {
				frequency: 'weekly',
				daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
				_rawPattern: weekdaysMatch[0]
			},
			matched: weekdaysMatch[0]
		};
	}
	
	// Weekends
	const weekendsMatch = text.match(RECURRENCE_PATTERNS.WEEKENDS);
	if (weekendsMatch) {
		return {
			pattern: {
				frequency: 'weekly',
				daysOfWeek: ['saturday', 'sunday'],
				_rawPattern: weekendsMatch[0]
			},
			matched: weekendsMatch[0]
		};
	}
	
	return { pattern: null, matched: null };
}

/**
 * Serialize recurrence pattern to string
 */
export function serializeRecurrence(pattern: RecurrencePattern): string {
	// Prefer using raw pattern for round-trip
	if (pattern._rawPattern) {
		return pattern._rawPattern;
	}
	
	// Generate from structured data
	if (pattern.daysOfWeek && pattern.daysOfWeek.length > 0) {
		if (pattern.daysOfWeek.length === 5 && 
			['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].every(d => pattern.daysOfWeek!.includes(d as DayOfWeek))) {
			return 'weekdays';
		}
		if (pattern.daysOfWeek.length === 2 && 
			pattern.daysOfWeek.includes('saturday') && pattern.daysOfWeek.includes('sunday')) {
			return 'weekends';
		}
		return `every ${pattern.daysOfWeek.join(', ')}`;
	}
	
	const interval = pattern.interval || 1;
	
	switch (pattern.frequency) {
		case 'daily':
			return interval === 1 ? 'daily' : `every ${interval} days`;
		case 'weekly':
			return interval === 1 ? 'weekly' : `every ${interval} weeks`;
		case 'monthly':
			return interval === 1 ? 'monthly' : `every ${interval} months`;
		case 'yearly':
			return interval === 1 ? 'yearly' : `every ${interval} years`;
		default:
			return 'daily';
	}
}

/**
 * Calculate next occurrence date based on recurrence pattern
 */
export function getNextOccurrence(pattern: RecurrencePattern, fromDate: Date = new Date()): Date {
	const next = new Date(fromDate);
	next.setHours(0, 0, 0, 0);
	const interval = pattern.interval || 1;
	
	switch (pattern.frequency) {
		case 'daily':
			next.setDate(next.getDate() + interval);
			break;
			
		case 'weekly':
			if (pattern.daysOfWeek && pattern.daysOfWeek.length > 0) {
				// Find next matching day
				const currentDay = next.getDay();
				const targetDays = pattern.daysOfWeek.map(d => DAY_NAMES[d]).sort((a, b) => a - b);
				
				// Find next day after current
				let nextDay = targetDays.find(d => d > currentDay);
				if (nextDay === undefined) {
					// Wrap to next week
					nextDay = targetDays[0];
					next.setDate(next.getDate() + (7 - currentDay + nextDay));
				} else {
					next.setDate(next.getDate() + (nextDay - currentDay));
				}
			} else {
				next.setDate(next.getDate() + 7 * interval);
			}
			break;
			
		case 'monthly':
			next.setMonth(next.getMonth() + interval);
			if (pattern.dayOfMonth) {
				next.setDate(Math.min(pattern.dayOfMonth, getDaysInMonth(next)));
			}
			break;
			
		case 'yearly':
			next.setFullYear(next.getFullYear() + interval);
			break;
	}
	
	return next;
}

// Helper: Get days in a month
function getDaysInMonth(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/**
 * Format relative date for display
 */
export function formatRelativeDate(dateStr: string, referenceDate: Date = new Date()): string {
	if (!dateStr) return '';
	
	const date = new Date(dateStr);
	const today = new Date(referenceDate);
	today.setHours(0, 0, 0, 0);
	date.setHours(0, 0, 0, 0);
	
	const diffTime = date.getTime() - today.getTime();
	const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
	
	if (diffDays === 0) return 'Today';
	if (diffDays === 1) return 'Tomorrow';
	if (diffDays === -1) return 'Yesterday';
	if (diffDays > 1 && diffDays < 7) return `In ${diffDays} days`;
	if (diffDays === 7) return 'In 1 week';
	if (diffDays > 7 && diffDays < 14) return `In ${diffDays} days`;
	if (diffDays >= 14 && diffDays < 30) return `In ${Math.floor(diffDays / 7)} weeks`;
	if (diffDays < -1 && diffDays > -7) return `${Math.abs(diffDays)} days ago`;
	if (diffDays === -7) return '1 week ago';
	if (diffDays < -7 && diffDays > -30) return `${Math.floor(Math.abs(diffDays) / 7)} weeks ago`;
	
	// For dates further out, show the day name if within this/next week
	const dayOfWeek = DAY_NAMES_REVERSE[date.getDay()];
	if (diffDays > 0 && diffDays <= 7) {
		return dayOfWeek.charAt(0).toUpperCase() + dayOfWeek.slice(1);
	}
	
	return dateStr; // Fall back to ISO date
}

// Extract ID from ^id-marker at end of line
function extractId(line: string): { content: string; id: string | null } {
	const idMatch = line.match(/\s*\^([\w-]+)\s*$/);
	if (idMatch) {
		return {
			content: line.replace(/\s*\^[\w-]+\s*$/, ''),
			id: idMatch[1]
		};
	}
	return { content: line, id: null };
}

// Parse metadata from [key::value] format
function parseInlineMetadata(text: string): { cleanText: string; metadata: BaseTaskMetadata } {
	const metadata: BaseTaskMetadata = {};
	let cleanText = text;

	// Match [key::value] patterns
	const metadataRegex = /\[(\w+)::([^\]]+)\]/g;
	let match;

	while ((match = metadataRegex.exec(text)) !== null) {
		const key = match[1].toLowerCase();
		const rawValue = match[2].trim();

		// Convert progress to number
		if (key === 'progress') {
			const numValue = parseInt(rawValue.replace('%', ''), 10);
			metadata[key] = isNaN(numValue) ? 0 : numValue;
		} else {
			metadata[key] = rawValue;
		}

		cleanText = cleanText.replace(match[0], '').trim();
	}

	// Also check for progress:: without brackets (common format)
	const progressMatch = cleanText.match(/progress::(\d+)%?/i);
	if (progressMatch && metadata.progress === undefined) {
		metadata.progress = parseInt(progressMatch[1], 10);
		cleanText = cleanText.replace(progressMatch[0] as string, '').trim();
	}

	// Check for project:: without brackets
	const projectMatch = cleanText.match(/project::([^\s\]]+)/i);
	if (projectMatch && !metadata.project) {
		metadata.project = projectMatch[1];
		cleanText = cleanText.replace(projectMatch[0], '').trim();
	}

	return { cleanText, metadata };
}

// Parse tags from text
function parseTags(text: string): { cleanText: string; tags: string[] } {
	const tagMatches = text.match(/#[\w-/]+/g) || [];
	const tags = tagMatches.map(tag => tag.substring(1));
	
	// Don't remove tags from cleanText - we'll handle display separately
	return { cleanText: text, tags };
}

// Parse date from @date or @@datetime format, including natural language
function parseDate(text: string, parseNatural: boolean = true): { 
	cleanText: string; 
	dueDate?: string; 
	dueTime?: string;
	recurrence?: RecurrencePattern;
	reminderTime?: string;
} {
	let cleanText = text;
	let dueDate: string | undefined;
	let dueTime: string | undefined;
	let recurrence: RecurrencePattern | undefined;
	let reminderTime: string | undefined;

	// Match @YYYY-MM-DD or @YYYY-MM-DDTHH:mm (ISO format takes priority)
	const dateTimeMatch = text.match(/@(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
	if (dateTimeMatch) {
		dueDate = dateTimeMatch[1];
		dueTime = dateTimeMatch[2];
		cleanText = cleanText.replace(dateTimeMatch[0], '').trim();
	}

	// Match @@HH:mm for time-only
	const timeOnlyMatch = text.match(/@@(\d{2}:\d{2})/);
	if (timeOnlyMatch && !dueTime) {
		dueTime = timeOnlyMatch[1];
		cleanText = cleanText.replace(timeOnlyMatch[0], '').trim();
	}

	// Parse natural language dates if enabled and no ISO date found
	if (parseNatural && !dueDate) {
		// Check for @natural-date format (e.g., @tomorrow, @next Monday)
		const naturalDatePrefixMatch = text.match(/@(today|tomorrow|yesterday|next\s+\w+|this\s+\w+|last\s+\w+|in\s+\d+\s+\w+|\d+\s+\w+\s+ago|end\s+of\s+\w+)/i);
		if (naturalDatePrefixMatch) {
			const { date, matched } = parseNaturalDate(naturalDatePrefixMatch[1]);
			if (date && matched) {
				dueDate = date;
				cleanText = cleanText.replace(`@${naturalDatePrefixMatch[1]}`, '').trim();
			}
		} else {
			// Also try parsing without @ prefix for inline natural dates
			const { date, matched } = parseNaturalDate(text);
			if (date && matched) {
				dueDate = date;
				cleanText = cleanText.replace(matched, '').trim();
			}
		}
	}

	// Parse recurrence patterns
	const { pattern, matched: recurMatched } = parseRecurrence(cleanText);
	if (pattern && recurMatched) {
		recurrence = pattern;
		cleanText = cleanText.replace(recurMatched, '').trim();
	}
	
	// Also check for [recur::pattern] metadata format
	const recurMetaMatch = cleanText.match(/\[recur::([^\]]+)\]/);
	if (recurMetaMatch && !recurrence) {
		const { pattern: metaPattern } = parseRecurrence(recurMetaMatch[1]);
		if (metaPattern) {
			recurrence = { ...metaPattern, _rawPattern: recurMetaMatch[1] };
		} else {
			// Store raw pattern even if we can't parse it
			recurrence = { frequency: 'daily', _rawPattern: recurMetaMatch[1] };
		}
		cleanText = cleanText.replace(recurMetaMatch[0], '').trim();
	}

	// Parse reminder time from [remind::time] metadata
	const remindMatch = cleanText.match(/\[remind::([^\]]+)\]/);
	if (remindMatch) {
		reminderTime = remindMatch[1];
		cleanText = cleanText.replace(remindMatch[0], '').trim();
	}

	return { cleanText, dueDate, dueTime, recurrence, reminderTime };
}

// Parse a single card from markdown lines
function parseCard(lines: string[], startIndex: number, parseNaturalDates: boolean = true): { card: KanbanCard | null; endIndex: number } {
	const line = lines[startIndex];
	
	// Match checkbox format: - [ ] or - [x]
	const checkboxMatch = line.match(/^(\s*)-\s*\[([ xX])\]\s*(.*)$/);
	if (!checkboxMatch) {
		return { card: null, endIndex: startIndex };
	}

	const cardIndent = checkboxMatch[1].length;
	const completed = checkboxMatch[2].toLowerCase() === 'x';
	let titleContent = checkboxMatch[3].trim();

	// Extract ID from end of line
	const { content: titleWithoutId, id: existingId } = extractId(titleContent);
	titleContent = titleWithoutId;

	// Parse metadata
	const { cleanText: afterMetadata, metadata } = parseInlineMetadata(titleContent);
	
	// Extract notePath from metadata (special handling for dedicated note links)
	let notePath: string | undefined;
	if (metadata.note) {
		notePath = metadata.note as string;
		delete metadata.note;
	}
	
	// Parse tags (keep in title, just extract list)
	const { tags } = parseTags(afterMetadata);
	
	// Parse date (with natural language and recurrence support)
	const { cleanText: finalTitle, dueDate, dueTime, recurrence, reminderTime } = parseDate(afterMetadata, parseNaturalDates);

	// Parse card content (indented lines following the card)
	// This includes notes (> lines), subtasks (- [ ] lines), and general content
	const notes: string[] = [];
	const contentLines: string[] = [];
	const subtasks: Subtask[] = [];
	let endIndex = startIndex;
	
	for (let i = startIndex + 1; i < lines.length; i++) {
		const contentLine = lines[i];
		
		// Check if line is indented more than the card (belongs to this card)
		const lineIndentMatch = contentLine.match(/^(\s*)/);
		const lineIndent = lineIndentMatch ? lineIndentMatch[1].length : 0;
		
		// Empty lines: check if followed by more card content
		if (contentLine.trim() === '') {
			// Look ahead to see if there's more content for this card
			let hasMoreContent = false;
			for (let j = i + 1; j < lines.length; j++) {
				const nextLine = lines[j];
				if (nextLine.trim() === '') continue;
				const nextIndent = (nextLine.match(/^(\s*)/) || ['', ''])[1].length;
				// If next non-empty line is indented or is a note/subtask line
				if (nextIndent > cardIndent || nextLine.match(/^\s*>/) || nextLine.match(/^\s+-\s*\[/)) {
					hasMoreContent = true;
				}
				break;
			}
			if (hasMoreContent) {
				contentLines.push('');
				endIndex = i;
				continue;
			} else {
				break;
			}
		}
		
		// Check if it's a note line (starts with > or whitespace + >)
		const noteMatch = contentLine.match(/^\s*>\s?(.*)$/);
		if (noteMatch) {
			notes.push(noteMatch[1]);
			contentLines.push(contentLine);
			endIndex = i;
			continue;
		}
		
		// Check if it's a subtask (indented checkbox)
		const subtaskMatch = contentLine.match(/^(\s+)-\s*\[([ xX])\]\s*(.*)$/);
		if (subtaskMatch && subtaskMatch[1].length > cardIndent) {
			const subtaskCompleted = subtaskMatch[2].toLowerCase() === 'x';
			const subtaskText = subtaskMatch[3].trim();
			const subtaskId = generateId();
			
			subtasks.push({
				id: subtaskId,
				text: subtaskText,
				completed: subtaskCompleted,
			});
			contentLines.push(contentLine);
			endIndex = i;
			continue;
		}
		
		// Check if it's other indented content (more indented than the card)
		if (lineIndent > cardIndent) {
			contentLines.push(contentLine);
			endIndex = i;
			continue;
		}
		
		// Not card content, stop parsing
		break;
	}

	const card: KanbanCard = {
		id: existingId || generateId(),
		title: afterMetadata, // Keep original with tags/dates for display control
		completed,
		tags,
		dueDate,
		dueTime,
		recurrence,
		reminderTime,
		notes: notes.length > 0 ? notes.join('\n') : undefined,
		notePath,
		content: contentLines.length > 0 ? contentLines.join('\n') : undefined,
		subtasks: subtasks.length > 0 ? subtasks : undefined,
		metadata,
		_rawLine: line,
	};

	return { card, endIndex };
}

// Parse a lane section
function parseLane(content: string): KanbanLane | null {
	const lines = content.split('\n');
	
	// First line should be ## header
	const headerLine = lines[0];
	const titleMatch = headerLine.match(/^##\s+(.+)$/);
	if (!titleMatch) return null;

	// Extract ID from header
	const { content: titleWithoutId, id: existingId } = extractId(titleMatch[1].trim());

	const lane: KanbanLane = {
		id: existingId || generateId(),
		title: titleWithoutId,
		cards: [],
		_rawHeader: headerLine,
	};

	// Parse cards
	let i = 1;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim().startsWith('- [')) {
			const { card, endIndex } = parseCard(lines, i);
			if (card) {
				lane.cards.push(card);
				i = endIndex + 1;
				continue;
			}
		}
		i++;
	}

	return lane;
}

// Parse settings from %% kanban:settings block
function parseSettings(content: string): BoardSettings {
	const settingsMatch = content.match(/%% kanban:settings\s*```(?:json)?\s*([\s\S]*?)\s*```\s*%%/);
	if (settingsMatch) {
		try {
			return JSON.parse(settingsMatch[1]);
		} catch {
			console.warn('Failed to parse kanban settings JSON');
			return {};
		}
	}
	return {};
}

// Extract frontmatter
function extractFrontmatter(content: string): { frontmatter: string; body: string } {
	const match = content.match(/^(---\s*\n[\s\S]*?\n---\s*\n?)/);
	if (match) {
		return {
			frontmatter: match[1],
			body: content.slice(match[1].length)
		};
	}
	return { frontmatter: '', body: content };
}

// Ensure frontmatter has kanban-plugin key
function ensureKanbanFrontmatter(frontmatter: string): string {
	if (!frontmatter) {
		return `---\n${FRONTMATTER_KEY}: basic\n---\n\n`;
	}
	
	if (!frontmatter.includes(FRONTMATTER_KEY)) {
		// Insert after first ---
		return frontmatter.replace(/^(---\s*\n)/, `$1${FRONTMATTER_KEY}: basic\n`);
	}
	
	return frontmatter;
}

// Find the end of actual kanban content within a lane section
function findLaneContentEnd(sectionContent: string): number {
	const lines = sectionContent.split('\n');
	let lastKanbanLineIndex = 0;
	
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Kanban content lines: header, cards, card notes, empty lines
		if (line.match(/^##\s/) || line.match(/^\s*-\s*\[/) || line.match(/^\s*>/)) {
			lastKanbanLineIndex = i;
		} else if (line.trim() === '') {
			// Empty lines are okay if followed by more kanban content
			// Look ahead to see if there's more kanban content
			let hasMoreKanban = false;
			for (let j = i + 1; j < lines.length; j++) {
				if (lines[j].match(/^\s*-\s*\[/) || lines[j].match(/^\s*>/)) {
					hasMoreKanban = true;
					break;
				} else if (lines[j].trim() !== '') {
					break;
				}
			}
			if (hasMoreKanban) {
				lastKanbanLineIndex = i;
			}
		}
	}
	
	// Calculate character position after the last kanban line
	let charPos = 0;
	for (let i = 0; i <= lastKanbanLineIndex; i++) {
		charPos += lines[i].length + 1; // +1 for newline
	}
	return charPos;
}

// Main parser function
export function parseKanbanBoard(markdown: string): KanbanBoard {
	const { frontmatter, body } = extractFrontmatter(markdown);
	
	// Find lane sections
	const laneSectionRegex = /^## .+$/gm;
	const laneMatches: { index: number; match: string }[] = [];
	let match;
	
	while ((match = laneSectionRegex.exec(body)) !== null) {
		laneMatches.push({ index: match.index, match: match[0] });
	}

	// Find settings block
	const settingsMatch = body.match(/%% kanban:settings[\s\S]*?%%/);
	const settingsStart = settingsMatch ? body.indexOf(settingsMatch[0]) : -1;
	const settingsEnd = settingsMatch ? settingsStart + settingsMatch[0].length : -1;

	// Extract header content (before first lane, or entire body if no lanes)
	let headerContent = '';
	if (laneMatches.length > 0) {
		headerContent = body.slice(0, laneMatches[0].index).trim();
	} else {
		// No lanes - preserve the entire body as header content
		// But exclude settings block if present
		if (settingsStart > 0) {
			headerContent = body.slice(0, settingsStart).trim();
		} else {
			headerContent = body.trim();
		}
	}

	// Parse lanes
	const lanes: KanbanLane[] = [];
	let archive: KanbanCard[] = [];
	let preSettingsContent = ''; // Content between last lane and settings block

	for (let i = 0; i < laneMatches.length; i++) {
		const start = laneMatches[i].index;
		let end: number;
		const isLastLane = i === laneMatches.length - 1;

		// Determine end of this lane section
		if (i + 1 < laneMatches.length) {
			end = laneMatches[i + 1].index;
		} else if (settingsStart > start) {
			end = settingsStart;
		} else {
			end = body.length;
		}

		const sectionContent = body.slice(start, end);
		const headerText = laneMatches[i].match;

		// For the last lane, check for non-kanban content before settings block
		if (isLastLane && settingsStart > start) {
			const contentEnd = findLaneContentEnd(sectionContent);
			const trailingContent = sectionContent.slice(contentEnd).trim();
			if (trailingContent) {
				preSettingsContent = trailingContent;
			}
		}

		// Check if this is the archive section
		if (headerText.match(/^##\s+Archive\s*$/i)) {
			const archiveLane = parseLane(sectionContent);
			if (archiveLane) {
				archive = archiveLane.cards;
			}
		} else {
			const lane = parseLane(sectionContent);
			if (lane) {
				lanes.push(lane);
			}
		}
	}

	// Extract footer content (after settings block, or after last lane if no settings)
	let footerContent = '';
	if (settingsEnd > 0) {
		// Content after settings block
		footerContent = body.slice(settingsEnd).trim();
	} else if (laneMatches.length > 0) {
		// No settings block - check for content after last lane
		const lastLaneIndex = laneMatches[laneMatches.length - 1].index;
		const lastLaneContent = body.slice(lastLaneIndex);
		const contentEnd = findLaneContentEnd(lastLaneContent);
		const trailingContent = lastLaneContent.slice(contentEnd).trim();
		if (trailingContent) {
			footerContent = trailingContent;
		}
	}

	const settings = parseSettings(body);

	return {
		lanes,
		archive,
		settings,
		_frontmatter: frontmatter,
		_headerContent: headerContent,
		_footerContent: footerContent,
		_preSettingsContent: preSettingsContent,
	};
}

// Serialize a card to markdown
function serializeCard(card: KanbanCard, includeId: boolean = true, serializationFormat: 'iso' | 'natural' = 'iso'): string {
	const checkbox = card.completed ? '[x]' : '[ ]';
	let content = card.title;

	// Add metadata that's not in title
	const metadataToAdd: string[] = [];
	
	if (card.metadata.progress !== undefined && !content.includes('progress::')) {
		metadataToAdd.push(`[progress::${card.metadata.progress}%]`);
	}
	if (card.metadata.project && !content.includes('project::') && !content.includes(`[project::`)) {
		metadataToAdd.push(`[project::${card.metadata.project}]`);
	}
	
	// Add notePath as [note::path] metadata if present and not already in title
	if (card.notePath && !content.includes('note::')) {
		metadataToAdd.push(`[note::${card.notePath}]`);
	}
	
	// Add recurrence as [recur::pattern] if present and not already in title
	if (card.recurrence && !content.includes('recur::') && !content.match(/\b(daily|weekly|monthly|yearly|every\s)/i)) {
		const recurStr = serializeRecurrence(card.recurrence);
		metadataToAdd.push(`[recur::${recurStr}]`);
	}
	
	// Add reminder time if present and not already in title
	if (card.reminderTime && !content.includes('remind::')) {
		metadataToAdd.push(`[remind::${card.reminderTime}]`);
	}
	
	// Add other metadata
	for (const [key, value] of Object.entries(card.metadata)) {
		if (key !== 'progress' && key !== 'project' && value !== undefined) {
			if (!content.includes(`${key}::`)) {
				metadataToAdd.push(`[${key}::${value}]`);
			}
		}
	}

	if (metadataToAdd.length > 0) {
		content = `${content} ${metadataToAdd.join(' ')}`;
	}

	// Add due date/time if not in title
	if (!content.includes('@')) {
		if (card.dueDate && card.dueTime) {
			content = `${content} @${card.dueDate}T${card.dueTime}`;
		} else if (card.dueDate) {
			content = `${content} @${card.dueDate}`;
		} else if (card.dueTime) {
			// Time-only: use @@ syntax
			content = `${content} @@${card.dueTime}`;
		}
	}

	// Add ID marker
	if (includeId) {
		content = `${content} ^${card.id}`;
	}

	let result = `- ${checkbox} ${content}`;

	// If we have raw content, use it (preserves original formatting)
	// Otherwise, serialize from structured data
	if (card.content && !card.notePath) {
		// Use existing content if available
		result += '\n' + card.content;
	} else {
		// Build content from structured data
		const contentParts: string[] = [];
		
		// Add subtasks
		if (card.subtasks && card.subtasks.length > 0) {
			for (const subtask of card.subtasks) {
				const subtaskCheckbox = subtask.completed ? '[x]' : '[ ]';
				contentParts.push(`\t- ${subtaskCheckbox} ${subtask.text}`);
			}
		}
		
		// Add inline notes (only if no dedicated note file)
		if (card.notes && !card.notePath) {
			const noteLines = card.notes.split('\n').map(line => `\t> ${line}`);
			contentParts.push(...noteLines);
		}
		
		if (contentParts.length > 0) {
			result += '\n' + contentParts.join('\n');
		}
	}

	return result;
}

/**
 * Parse subtasks from content string
 */
export function parseSubtasksFromContent(content: string): Subtask[] {
	const subtasks: Subtask[] = [];
	const lines = content.split('\n');
	
	for (const line of lines) {
		const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
		if (match) {
			subtasks.push({
				id: generateId(),
				text: match[2].trim(),
				completed: match[1].toLowerCase() === 'x',
			});
		}
	}
	
	return subtasks;
}

/**
 * Update subtask completion in content string
 */
export function updateSubtaskInContent(content: string, subtaskIndex: number, completed: boolean): string {
	const lines = content.split('\n');
	let subtaskCount = 0;
	
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^(\s*-\s*\[)([ xX])(\]\s*.*)$/);
		if (match) {
			if (subtaskCount === subtaskIndex) {
				lines[i] = `${match[1]}${completed ? 'x' : ' '}${match[3]}`;
				break;
			}
			subtaskCount++;
		}
	}
	
	return lines.join('\n');
}

/**
 * Add a subtask to content string
 */
export function addSubtaskToContent(content: string | undefined, subtaskText: string): string {
	const newSubtask = `\t- [ ] ${subtaskText}`;
	
	if (!content || content.trim() === '') {
		return newSubtask;
	}
	
	return content + '\n' + newSubtask;
}

// Serialize a lane to markdown
function serializeLane(lane: KanbanLane, includeIds: boolean = true): string {
	const idMarker = includeIds ? ` ^${lane.id}` : '';
	const lines = [`## ${lane.title}${idMarker}`, ''];
	
	for (const card of lane.cards) {
		lines.push(serializeCard(card, includeIds));
	}
	
	lines.push('');
	return lines.join('\n');
}

// Serialize settings block
function serializeSettings(settings: BoardSettings): string {
	if (Object.keys(settings).length === 0) return '';
	
	const json = JSON.stringify(settings, null, 2);
	return `\n%% kanban:settings\n\`\`\`json\n${json}\n\`\`\`\n%%\n`;
}

// Serialize archive section
function serializeArchive(archive: KanbanCard[], includeIds: boolean = true): string {
	if (archive.length === 0) return '';
	
	const lines = ['## Archive', ''];
	for (const card of archive) {
		lines.push(serializeCard(card, includeIds));
	}
	lines.push('');
	return lines.join('\n');
}

// Main serializer function - preserves original content
export function serializeKanbanBoard(board: KanbanBoard): string {
	const parts: string[] = [];

	// Frontmatter (ensure kanban key exists)
	const frontmatter = ensureKanbanFrontmatter(board._frontmatter || '');
	parts.push(frontmatter);

	// Header content (preserved)
	if (board._headerContent) {
		parts.push(board._headerContent);
		parts.push('');
	}

	// Lanes
	for (const lane of board.lanes) {
		parts.push(serializeLane(lane));
	}

	// Archive
	if (board.archive.length > 0) {
		parts.push(serializeArchive(board.archive));
	}

	// Pre-settings content (preserved - content between last lane and settings block)
	if (board._preSettingsContent) {
		parts.push(board._preSettingsContent);
		parts.push('');
	}

	// Settings
	const settingsBlock = serializeSettings(board.settings);
	if (settingsBlock) {
		parts.push(settingsBlock);
	}

	// Footer content (preserved)
	if (board._footerContent) {
		parts.push(board._footerContent);
	}

	// Join parts without aggressive newline normalization to preserve original formatting
	return parts.join('\n');
}

// Create an empty board
export function createEmptyBoard(): KanbanBoard {
	return {
		lanes: [
			{
				id: generateId(),
				title: 'To Do',
				cards: [],
			},
			{
				id: generateId(),
				title: 'In Progress',
				cards: [],
			},
			{
				id: generateId(),
				title: 'Done',
				cards: [],
			},
		],
		archive: [],
		settings: {},
	};
}

// Check if content has kanban frontmatter
export function hasFrontmatterKey(content: string): boolean {
	const frontmatterMatch = content.match(/^---\s*([\s\S]*?)\s*---/);
	if (!frontmatterMatch) return false;
	return frontmatterMatch[1].includes(FRONTMATTER_KEY);
}

// Basic frontmatter for new boards
export const BASIC_FRONTMATTER = `---\n${FRONTMATTER_KEY}: basic\n---\n\n`;

// Format date based on settings
export function formatDate(dateStr: string, format: string, relative: boolean = false): string {
	if (!dateStr) return '';
	
	if (relative) {
		const date = new Date(dateStr);
		const now = new Date();
		const diffDays = Math.floor((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
		
		if (diffDays === 0) return 'Today';
		if (diffDays === 1) return 'Tomorrow';
		if (diffDays === -1) return 'Yesterday';
		if (diffDays > 1 && diffDays < 7) return `In ${diffDays} days`;
		if (diffDays < -1 && diffDays > -7) return `${Math.abs(diffDays)} days ago`;
	}
	
	// Simple format replacement (moment.js compatible subset)
	const date = new Date(dateStr);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	
	return format
		.replace('YYYY', String(year))
		.replace('MM', month)
		.replace('DD', day);
}

// Prepend archive date to card title
export function prependArchiveDate(card: KanbanCard, format: string): KanbanCard {
	const now = new Date();
	const dateStr = formatDate(now.toISOString().split('T')[0], format);
	
	return {
		...card,
		title: `${dateStr} ${card.title}`,
	};
}

// Create a card from a template file content
export function createCardFromTemplate(
	templateContent: string, 
	defaultMetadata: BaseTaskMetadata = {},
	templateContext?: TemplateContextOptions
): KanbanCard {
	// Create context with defaults
	const context = createTemplateContext({
		project: defaultMetadata.project,
		...templateContext,
	});
	
	// Substitute variables in template content
	const processedContent = substituteTemplateVariables(templateContent, context);
	
	// Extract title from first heading or first line
	const headingMatch = processedContent.match(/^#\s+(.+)$/m);
	const title = headingMatch ? headingMatch[1] : processedContent.split('\n')[0].trim() || 'New card';
	
	// Extract metadata from frontmatter if present
	const fmMatch = processedContent.match(/^---\s*\n([\s\S]*?)\n---/);
	const metadata: BaseTaskMetadata = { ...defaultMetadata };
	
	if (fmMatch) {
		const fmContent = fmMatch[1];
		// Parse simple YAML
		const lines = fmContent.split('\n');
		for (const line of lines) {
			const kvMatch = line.match(/^(\w+):\s*(.+)$/);
			if (kvMatch) {
				const key = kvMatch[1].toLowerCase();
				const value = kvMatch[2].trim();
				if (METADATA_KEYS.includes(key)) {
					if (key === 'progress') {
						metadata.progress = parseInt(value.replace('%', ''), 10);
					} else {
						metadata[key] = value;
					}
				}
			}
		}
	}
	
	// Extract tags from title
	const tagMatches = title.match(/#[\w-/]+/g) || [];
	const tags = tagMatches.map(tag => tag.substring(1));
	
	// Extract due date from title if present
	const dateMatch = title.match(/@(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
	const dueDate = dateMatch ? dateMatch[1] : undefined;
	const dueTime = dateMatch ? dateMatch[2] : undefined;
	
	return {
		id: context.id,
		title,
		completed: false,
		tags,
		dueDate,
		dueTime,
		metadata,
		notes: processedContent,
	};
}

/**
 * Process template for card note creation (returns full content with substitutions)
 */
export function processNoteTemplate(templateContent: string, context: TemplateContext): string {
	return substituteTemplateVariables(templateContent, context);
}
