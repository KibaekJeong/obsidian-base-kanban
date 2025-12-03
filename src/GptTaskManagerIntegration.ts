/**
 * GPT Task Manager Integration for Base Kanban
 * 
 * This module provides integration between Base Kanban and GPT Task Manager plugin,
 * allowing users to view and manage GPT Task Manager tasks in a Kanban board format.
 * 
 * Key features:
 * - Parse GPT Task Manager task files and extract task metadata
 * - Create Kanban boards from GPT Task Manager tasks (filtered by Epic, Project, etc.)
 * - Sync card movements to GPT Task Manager status fields
 * - Provide commands to toggle between Kanban and GPT Task Manager views
 */

import { App, TFile, TFolder, Notice, normalizePath } from 'obsidian';
import { 
	GptTaskManagerConfig, 
	KanbanBoard, 
	KanbanLane, 
	KanbanCard, 
	GPT_TASK_MANAGER_LANE_MAPPING,
	DEFAULT_GPT_TASK_MANAGER_CONFIG 
} from './types';

// Task metadata extracted from GPT Task Manager task file
export interface GptTaskMetadata {
	type?: string;
	area?: string;
	goal?: string;
	project?: string;
	epic?: string;
	status?: string;
	priority?: string;
	due?: string;
	created?: string;
	updated?: string;
	parent?: string;
	tags?: string[];
	description?: string;
}

// Parsed GPT Task Manager task
export interface GptTask {
	file: TFile;
	title: string;
	metadata: GptTaskMetadata;
	syncChecklistItem?: string;  // The checkbox item from ## 🔄 Sync section
	completed: boolean;
	content: string;
}

/**
 * Parse frontmatter from a GPT Task Manager task file
 */
export function parseGptTaskFrontmatter(content: string): GptTaskMetadata {
	const metadata: GptTaskMetadata = {};
	
	const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) {
		return metadata;
	}
	
	const frontmatter = frontmatterMatch[1];
	const lines = frontmatter.split('\n');
	
	for (const line of lines) {
		// Match key: value or key: "[[value]]"
		const kvMatch = line.match(/^(\w+):\s*(.+)$/);
		if (kvMatch) {
			const key = kvMatch[1];
			let value = kvMatch[2].trim();
			
			// Remove quotes and wiki-link brackets
			value = value.replace(/^["']|["']$/g, '');
			value = value.replace(/^\[\[|\]\]$/g, '');
			
			// Map to metadata fields
			switch (key.toLowerCase()) {
				case 'type':
					metadata.type = value;
					break;
				case 'area':
					metadata.area = value;
					break;
				case 'goal':
					metadata.goal = value;
					break;
				case 'project':
					metadata.project = value;
					break;
				case 'epic':
					metadata.epic = value;
					break;
				case 'status':
					metadata.status = value;
					break;
				case 'priority':
					metadata.priority = value;
					break;
				case 'due':
					metadata.due = value;
					break;
				case 'created':
					metadata.created = value;
					break;
				case 'updated':
					metadata.updated = value;
					break;
				case 'parent':
					metadata.parent = value;
					break;
				case 'description':
					metadata.description = value;
					break;
				case 'tags':
					// Tags are usually a YAML list, handle both formats
					if (value.startsWith('[')) {
						// Inline array format
						metadata.tags = value.replace(/[\[\]]/g, '').split(',').map(t => t.trim());
					}
					break;
			}
		}
		
		// Handle multi-line tags
		if (line.trim().startsWith('- ') && metadata.tags === undefined) {
			// This might be part of a tags list
			const tagValue = line.trim().replace(/^-\s*/, '');
			if (!metadata.tags) {
				metadata.tags = [];
			}
			metadata.tags.push(tagValue);
		}
	}
	
	return metadata;
}

/**
 * Extract the sync checklist item from ## 🔄 Sync section
 */
export function extractSyncChecklistItem(content: string): { text: string; completed: boolean } | null {
	// Find the ## 🔄 Sync section
	const syncSectionMatch = content.match(/## 🔄 Sync\s*\n([\s\S]*?)(?=\n## |$)/);
	if (!syncSectionMatch) {
		return null;
	}
	
	const syncSection = syncSectionMatch[1];
	
	// Find the first checkbox item
	const checkboxMatch = syncSection.match(/-\s*\[([ xX])\]\s*(.+)/);
	if (!checkboxMatch) {
		return null;
	}
	
	return {
		completed: checkboxMatch[1].toLowerCase() === 'x',
		text: checkboxMatch[2].trim(),
	};
}

/**
 * Parse a GPT Task Manager task file
 */
export async function parseGptTaskFile(app: App, file: TFile): Promise<GptTask | null> {
	try {
		const content = await app.vault.read(file);
		const metadata = parseGptTaskFrontmatter(content);
		
		// Check if this looks like a GPT Task Manager task (has Type: "[[Tasks]]")
		if (!metadata.type || !metadata.type.includes('Tasks')) {
			return null;
		}
		
		const syncItem = extractSyncChecklistItem(content);
		const title = syncItem?.text || file.basename;
		
		return {
			file,
			title,
			metadata,
			syncChecklistItem: syncItem?.text,
			completed: syncItem?.completed || false,
			content,
		};
	} catch (error) {
		console.error(`Failed to parse GPT task file: ${file.path}`, error);
		return null;
	}
}

/**
 * Query GPT Task Manager tasks from a folder
 */
export async function queryGptTasks(
	app: App, 
	config: GptTaskManagerConfig,
	filter?: {
		epic?: string;
		project?: string;
		status?: string[];
		includeCompleted?: boolean;
	}
): Promise<GptTask[]> {
	const tasks: GptTask[] = [];
	
	const folder = app.vault.getAbstractFileByPath(config.tasksFolder);
	if (!(folder instanceof TFolder)) {
		console.warn(`GPT Task Manager tasks folder not found: ${config.tasksFolder}`);
		return tasks;
	}
	
	// Recursively get all markdown files
	const getAllMarkdownFiles = (folder: TFolder): TFile[] => {
		const files: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') {
				files.push(child);
			} else if (child instanceof TFolder) {
				files.push(...getAllMarkdownFiles(child));
			}
		}
		return files;
	};
	
	const files = getAllMarkdownFiles(folder);
	
	for (const file of files) {
		const task = await parseGptTaskFile(app, file);
		if (!task) continue;
		
		// Apply filters
		if (filter) {
			if (filter.epic && task.metadata.epic !== filter.epic) {
				continue;
			}
			if (filter.project && task.metadata.project !== filter.project) {
				continue;
			}
			if (filter.status && filter.status.length > 0 && task.metadata.status) {
				if (!filter.status.includes(task.metadata.status)) {
					continue;
				}
			}
			if (!filter.includeCompleted && task.completed) {
				continue;
			}
		}
		
		tasks.push(task);
	}
	
	return tasks;
}

/**
 * Convert GPT Task Manager status to lane title
 */
export function statusToLane(status: string | undefined, config: GptTaskManagerConfig): string {
	if (!status) return 'Backlog';
	
	const statusLower = status.toLowerCase();
	const { statusValues } = config;
	
	if (statusLower === statusValues.backlog) return 'Backlog';
	if (statusLower === statusValues.todo) return 'To Do';
	if (statusLower === statusValues.inProgress) return 'In Progress';
	if (statusLower === statusValues.done) return 'Done';
	
	// Default to Backlog for unknown statuses
	return 'Backlog';
}

/**
 * Convert lane title to GPT Task Manager status
 */
export function laneToStatus(laneTitle: string, config: GptTaskManagerConfig): string {
	const laneLower = laneTitle.toLowerCase();
	const { statusValues } = config;
	
	if (laneLower === 'backlog' || laneLower.includes('backlog')) {
		return statusValues.backlog;
	}
	if (laneLower === 'to do' || laneLower === 'todo' || laneLower.includes('todo')) {
		return statusValues.todo;
	}
	if (laneLower === 'in progress' || laneLower.includes('progress') || laneLower.includes('doing')) {
		return statusValues.inProgress;
	}
	if (laneLower === 'done' || laneLower.includes('done') || laneLower.includes('complete')) {
		return statusValues.done;
	}
	
	// Default to backlog
	return statusValues.backlog;
}

/**
 * Convert GPT Task to Kanban Card
 */
export function gptTaskToKanbanCard(task: GptTask): KanbanCard {
	const generateId = () => Math.random().toString(36).substring(2, 11) + Date.now().toString(36).slice(-4);
	
	return {
		id: generateId(),
		title: task.title,
		completed: task.completed,
		tags: task.metadata.tags || [],
		dueDate: task.metadata.due,
		metadata: {
			project: task.metadata.project,
			priority: task.metadata.priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
			status: task.metadata.status,
		},
		baseTaskPath: task.file.path,
		baseSyncTime: Date.now(),
	};
}

/**
 * Create a Kanban board from GPT Task Manager tasks
 */
export function createBoardFromGptTasks(
	tasks: GptTask[],
	config: GptTaskManagerConfig,
	boardTitle?: string
): KanbanBoard {
	const generateId = () => Math.random().toString(36).substring(2, 11) + Date.now().toString(36).slice(-4);
	
	// Create lanes based on GPT Task Manager status values
	const lanes: KanbanLane[] = [
		{ id: generateId(), title: 'Backlog', cards: [] },
		{ id: generateId(), title: 'To Do', cards: [] },
		{ id: generateId(), title: 'In Progress', cards: [] },
		{ id: generateId(), title: 'Done', cards: [] },
	];
	
	// Sort tasks into lanes based on status
	for (const task of tasks) {
		const card = gptTaskToKanbanCard(task);
		const laneTitle = statusToLane(task.metadata.status, config);
		
		const lane = lanes.find(l => l.title === laneTitle);
		if (lane) {
			lane.cards.push(card);
		} else {
			// Default to Backlog if lane not found
			lanes[0].cards.push(card);
		}
	}
	
	// Sort cards by priority within each lane
	const priorityOrder: Record<string, number> = {
		'critical': 0,
		'high': 1,
		'medium': 2,
		'low': 3,
	};
	
	for (const lane of lanes) {
		lane.cards.sort((a, b) => {
			const aPriority = priorityOrder[a.metadata.priority || 'medium'] ?? 2;
			const bPriority = priorityOrder[b.metadata.priority || 'medium'] ?? 2;
			return aPriority - bPriority;
		});
	}
	
	return {
		lanes,
		archive: [],
		settings: {
			'lane-width': '300px',
			'show-checkboxes': true,
			'show-progress': true,
			'show-project': true,
			'base-sync': {
				enabled: true,
				tasksFolder: config.tasksFolder,
				query: '',
				statusField: config.statusField,
				progressField: 'progress',
				projectField: config.projectField,
				laneMapping: { ...GPT_TASK_MANAGER_LANE_MAPPING },
				conflictResolution: 'prompt',
				syncInterval: 0,
				createMissingTasks: false,
				archiveCompletedTasks: false,
			},
		},
		_frontmatter: `---\nkanban-plugin: basic\ntitle: ${boardTitle || 'Task Board'}\n---\n\n`,
	};
}

/**
 * Update GPT Task Manager task status in the file
 */
export async function updateGptTaskStatus(
	app: App,
	taskPath: string,
	newStatus: string,
	config: GptTaskManagerConfig
): Promise<boolean> {
	try {
		const file = app.vault.getAbstractFileByPath(taskPath);
		if (!(file instanceof TFile)) {
			console.warn(`Task file not found: ${taskPath}`);
			return false;
		}
		
		let content = await app.vault.read(file);
		
		// Update status in frontmatter
		const statusRegex = new RegExp(`^(${config.statusField}:)\\s*.+$`, 'mi');
		if (statusRegex.test(content)) {
			content = content.replace(statusRegex, `$1 ${newStatus}`);
		} else {
			// Add status field if not present
			const frontmatterEndMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
			if (frontmatterEndMatch) {
				const frontmatter = frontmatterEndMatch[1];
				const newFrontmatter = frontmatter + `\n${config.statusField}: ${newStatus}`;
				content = content.replace(frontmatterEndMatch[1], newFrontmatter);
			}
		}
		
		// Update the Updated timestamp
		const updatedRegex = /^(Updated:)\s*.+$/mi;
		const now = new Date();
		const timestamp = `"${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}"`;
		if (updatedRegex.test(content)) {
			content = content.replace(updatedRegex, `$1 ${timestamp}`);
		}
		
		await app.vault.modify(file, content);
		return true;
	} catch (error) {
		console.error(`Failed to update GPT task status: ${taskPath}`, error);
		return false;
	}
}

/**
 * Update GPT Task Manager task checkbox completion
 */
export async function updateGptTaskCompletion(
	app: App,
	taskPath: string,
	completed: boolean
): Promise<boolean> {
	try {
		const file = app.vault.getAbstractFileByPath(taskPath);
		if (!(file instanceof TFile)) {
			console.warn(`Task file not found: ${taskPath}`);
			return false;
		}
		
		let content = await app.vault.read(file);
		
		// Find and update the checkbox in ## 🔄 Sync section
		const syncSectionMatch = content.match(/(## 🔄 Sync\s*\n)([\s\S]*?)(?=\n## |$)/);
		if (syncSectionMatch) {
			const sectionContent = syncSectionMatch[2];
			const newSectionContent = sectionContent.replace(
				/-\s*\[[ xX]\]/,
				completed ? '- [x]' : '- [ ]'
			);
			content = content.replace(syncSectionMatch[0], syncSectionMatch[1] + newSectionContent);
		}
		
		await app.vault.modify(file, content);
		return true;
	} catch (error) {
		console.error(`Failed to update GPT task completion: ${taskPath}`, error);
		return false;
	}
}

/**
 * Get available Epics from GPT Task Manager epics folder
 */
export async function getGptEpics(app: App, config: GptTaskManagerConfig): Promise<string[]> {
	const epics: string[] = [];
	
	const folder = app.vault.getAbstractFileByPath(config.epicsFolder);
	if (!(folder instanceof TFolder)) {
		return epics;
	}
	
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === 'md') {
			epics.push(child.basename);
		}
	}
	
	return epics.sort();
}

/**
 * Get available Projects from GPT Task Manager projects folder
 */
export async function getGptProjects(app: App, config: GptTaskManagerConfig): Promise<string[]> {
	const projects: string[] = [];
	
	const folder = app.vault.getAbstractFileByPath(config.projectsFolder);
	if (!(folder instanceof TFolder)) {
		return projects;
	}
	
	const getAllFolderNames = (folder: TFolder): string[] => {
		const names: string[] = [];
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				names.push(child.name);
				names.push(...getAllFolderNames(child));
			} else if (child instanceof TFile && child.extension === 'md') {
				names.push(child.basename);
			}
		}
		return names;
	};
	
	return getAllFolderNames(folder).sort();
}

/**
 * Check if GPT Task Manager integration is properly configured
 */
export function isGptIntegrationConfigured(config: GptTaskManagerConfig): boolean {
	return config.enabled && !!config.tasksFolder;
}

/**
 * Auto-configure Base Sync settings for GPT Task Manager integration
 */
export function configureBaseSyncForGpt(config: GptTaskManagerConfig): import('./types').BaseSyncConfig {
	return {
		enabled: true,
		tasksFolder: config.tasksFolder,
		query: '',
		statusField: config.statusField,
		progressField: 'progress',
		projectField: config.projectField,
		laneMapping: { ...GPT_TASK_MANAGER_LANE_MAPPING },
		conflictResolution: 'prompt',
		syncInterval: 0,
		createMissingTasks: false,
		archiveCompletedTasks: false,
	};
}

