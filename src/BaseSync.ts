/**
 * Base Sync Service
 * 
 * Handles bidirectional sync between Kanban cards and Obsidian Base tasks.
 * 
 * Features:
 * - Lane move → Base status field update
 * - Progress/project field sync
 * - Background sync to pull Base tasks into lanes
 * - Conflict resolution (local, remote, or prompt)
 */

import { App, TFile, TFolder, Notice, Modal, Setting } from 'obsidian';
import type { TAbstractFile } from 'obsidian';
import { KanbanCard, KanbanLane, KanbanBoard, BaseSyncConfig, BaseTaskMetadata, DEFAULT_BASE_SYNC_CONFIG, ConflictResolution } from './types';

// Base task representation from frontmatter
export interface BaseTask {
	path: string;
	title: string;
	status?: string;
	progress?: number;
	project?: string;
	priority?: string;
	dueDate?: string;
	tags?: string[];
	completed?: boolean;
	modified?: number;  // File modification time
	[key: string]: string | number | boolean | string[] | undefined;
}

// Sync result for reporting
export interface SyncResult {
	created: number;
	updated: number;
	conflicts: SyncConflict[];
	errors: string[];
}

// Conflict information
export interface SyncConflict {
	cardId: string;
	cardTitle: string;
	taskPath: string;
	localValue: string;
	remoteValue: string;
	field: string;
}

export class BaseSyncService {
	private app: App;
	private config: BaseSyncConfig;
	private syncInProgress: boolean = false;

	constructor(app: App, config?: BaseSyncConfig) {
		this.app = app;
		this.config = config || { ...DEFAULT_BASE_SYNC_CONFIG };
	}

	/**
	 * Update the sync configuration
	 */
	setConfig(config: BaseSyncConfig): void {
		this.config = config;
	}

	/**
	 * Get current configuration
	 */
	getConfig(): BaseSyncConfig {
		return this.config;
	}

	/**
	 * Check if sync is enabled
	 */
	isEnabled(): boolean {
		return this.config.enabled;
	}

	// ============ Read Operations ============

	/**
	 * Read a Base task from a file
	 */
	async readBaseTask(file: TFile): Promise<BaseTask | null> {
		try {
			const content = await this.app.vault.read(file);
			const frontmatter = this.parseFrontmatter(content);
			
			if (!frontmatter) return null;

			return {
				path: file.path,
				title: frontmatter.title || file.basename,
				status: frontmatter[this.config.statusField],
				progress: frontmatter[this.config.progressField],
				project: frontmatter[this.config.projectField],
				priority: frontmatter.priority,
				dueDate: frontmatter.due || frontmatter.dueDate,
				tags: frontmatter.tags,
				completed: frontmatter.completed === true || frontmatter.status === 'done',
				modified: file.stat.mtime,
				...frontmatter,
			};
		} catch (error) {
			console.error(`Error reading Base task ${file.path}:`, error);
			return null;
		}
	}

	/**
	 * Query Base tasks from the tasks folder
	 */
	async queryBaseTasks(): Promise<BaseTask[]> {
		const tasks: BaseTask[] = [];
		const folder = this.app.vault.getAbstractFileByPath(this.config.tasksFolder);
		
		if (!(folder instanceof TFolder)) {
			console.warn(`Tasks folder not found: ${this.config.tasksFolder}`);
			return tasks;
		}

		const files = this.getMarkdownFiles(folder);
		
		for (const file of files) {
			const task = await this.readBaseTask(file);
			if (task && this.matchesQuery(task)) {
				tasks.push(task);
			}
		}

		return tasks;
	}

	/**
	 * Get all markdown files recursively from a folder
	 */
	private getMarkdownFiles(folder: TFolder): TFile[] {
		const files: TFile[] = [];
		
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') {
				files.push(child);
			} else if (child instanceof TFolder) {
				files.push(...this.getMarkdownFiles(child));
			}
		}
		
		return files;
	}

	/**
	 * Check if a task matches the configured query
	 */
	private matchesQuery(task: BaseTask): boolean {
		if (!this.config.query || this.config.query.trim() === '') {
			return true;
		}

		const query = this.config.query.toLowerCase();
		
		// Simple query parsing - supports:
		// status:value, project:value, tag:value, priority:value
		const conditions = query.split(/\s+and\s+/i);
		
		for (const condition of conditions) {
			const trimmed = condition.trim();
			
			// status:value
			const statusMatch = trimmed.match(/^status:\s*(.+)$/i);
			if (statusMatch) {
				const expected = statusMatch[1].toLowerCase();
				if (task.status?.toLowerCase() !== expected) return false;
				continue;
			}
			
			// project:value
			const projectMatch = trimmed.match(/^project:\s*(.+)$/i);
			if (projectMatch) {
				const expected = projectMatch[1].toLowerCase();
				if (task.project?.toLowerCase() !== expected) return false;
				continue;
			}
			
			// tag:value
			const tagMatch = trimmed.match(/^tag:\s*(.+)$/i);
			if (tagMatch) {
				const expected = tagMatch[1].toLowerCase();
				if (!task.tags?.some(t => t.toLowerCase() === expected)) return false;
				continue;
			}
			
			// priority:value
			const priorityMatch = trimmed.match(/^priority:\s*(.+)$/i);
			if (priorityMatch) {
				const expected = priorityMatch[1].toLowerCase();
				if (task.priority?.toLowerCase() !== expected) return false;
				continue;
			}
			
			// completed:true/false
			const completedMatch = trimmed.match(/^completed:\s*(true|false)$/i);
			if (completedMatch) {
				const expected = completedMatch[1].toLowerCase() === 'true';
				if (task.completed !== expected) return false;
				continue;
			}
		}

		return true;
	}

	// ============ Write Operations ============

	/**
	 * Update a Base task's frontmatter field
	 */
	async updateTaskField(taskPath: string, field: string, value: string | number | boolean | undefined): Promise<boolean> {
		try {
			const file = this.app.vault.getAbstractFileByPath(taskPath);
			if (!(file instanceof TFile)) {
				console.warn(`Task file not found: ${taskPath}`);
				return false;
			}

			const content = await this.app.vault.read(file);
			const updatedContent = this.updateFrontmatterField(content, field, value);
			
			if (updatedContent !== content) {
				await this.app.vault.modify(file, updatedContent);
				return true;
			}
			
			return false;
		} catch (error) {
			console.error(`Error updating task ${taskPath}:`, error);
			return false;
		}
	}

	/**
	 * Update multiple fields at once
	 */
	async updateTaskFields(taskPath: string, fields: Record<string, string | number | boolean | undefined>): Promise<boolean> {
		try {
			const file = this.app.vault.getAbstractFileByPath(taskPath);
			if (!(file instanceof TFile)) {
				console.warn(`Task file not found: ${taskPath}`);
				return false;
			}

			let content = await this.app.vault.read(file);
			
			for (const [field, value] of Object.entries(fields)) {
				content = this.updateFrontmatterField(content, field, value);
			}
			
			await this.app.vault.modify(file, content);
			return true;
		} catch (error) {
			console.error(`Error updating task ${taskPath}:`, error);
			return false;
		}
	}

	/**
	 * Create a new Base task file
	 */
	async createBaseTask(title: string, metadata: BaseTaskMetadata, lane?: KanbanLane): Promise<string | null> {
		try {
			// Ensure tasks folder exists
			const folder = this.app.vault.getAbstractFileByPath(this.config.tasksFolder);
			if (!(folder instanceof TFolder)) {
				// Create the folder if it doesn't exist
				try {
					await this.app.vault.createFolder(this.config.tasksFolder);
				} catch (folderError) {
					// Folder might already exist or be a file - check again
					const recheckFolder = this.app.vault.getAbstractFileByPath(this.config.tasksFolder);
					if (!(recheckFolder instanceof TFolder)) {
						console.error('Cannot create tasks folder:', this.config.tasksFolder, folderError);
						return null;
					}
				}
			}

			// Generate safe filename - handle empty titles
			const safeTitle = (title || 'Untitled Task')
				.replace(/[\\/:*?"<>|]/g, '-')
				.replace(/\s+/g, ' ')
				.trim()
				.substring(0, 100) || 'task';
			
			const timestamp = Date.now();
			const filename = `${safeTitle}-${timestamp}.md`;
			const filepath = `${this.config.tasksFolder}/${filename}`;

			// Build frontmatter
			const frontmatter: Record<string, string | number | boolean | undefined> = {
				title: title || 'Untitled Task',
				created: new Date().toISOString(),
			};

			// Add status from lane
			if (lane && this.config.laneMapping[lane.title]) {
				frontmatter[this.config.statusField] = this.config.laneMapping[lane.title];
			}

			// Add metadata fields
			if (metadata.progress !== undefined) {
				frontmatter[this.config.progressField] = metadata.progress;
			}
			if (metadata.project) {
				frontmatter[this.config.projectField] = metadata.project;
			}
			if (metadata.priority) {
				frontmatter.priority = metadata.priority;
			}

			// Create file content
			const content = this.createFileWithFrontmatter(frontmatter, `# ${title || 'Untitled Task'}\n`);
			
			await this.app.vault.create(filepath, content);
			return filepath;
		} catch (error) {
			console.error('Error creating Base task:', error);
			return null;
		}
	}

	// ============ Sync Operations ============

	/**
	 * Handle card moving to a new lane - update Base status
	 */
	async onCardMoveToLane(card: KanbanCard, newLane: KanbanLane): Promise<boolean> {
		if (!this.config.enabled || !card.baseTaskPath) {
			return false;
		}

		const newStatus = this.config.laneMapping[newLane.title];
		if (!newStatus) {
			// No mapping for this lane
			return false;
		}

		return await this.updateTaskField(card.baseTaskPath, this.config.statusField, newStatus);
	}

	/**
	 * Sync card progress to Base task
	 */
	async syncProgress(card: KanbanCard, progress: number): Promise<boolean> {
		if (!this.config.enabled || !card.baseTaskPath) {
			return false;
		}

		return await this.updateTaskField(card.baseTaskPath, this.config.progressField, progress);
	}

	/**
	 * Sync card project to Base task
	 */
	async syncProject(card: KanbanCard, project: string | undefined): Promise<boolean> {
		if (!this.config.enabled || !card.baseTaskPath) {
			return false;
		}

		return await this.updateTaskField(card.baseTaskPath, this.config.projectField, project || '');
	}

	/**
	 * Full sync: pull Base tasks into the board
	 */
	async syncFromBase(board: KanbanBoard, onConflict?: (conflict: SyncConflict) => Promise<ConflictResolution | 'skip'>): Promise<SyncResult> {
		if (this.syncInProgress) {
			return { created: 0, updated: 0, conflicts: [], errors: ['Sync already in progress'] };
		}

		// Guard: cannot sync to a board with no lanes
		if (!board.lanes || board.lanes.length === 0) {
			return { created: 0, updated: 0, conflicts: [], errors: ['Board has no lanes - add at least one lane before syncing'] };
		}

		this.syncInProgress = true;
		const result: SyncResult = { created: 0, updated: 0, conflicts: [], errors: [] };

		try {
			const tasks = await this.queryBaseTasks();
			
			// Build a map of existing cards by baseTaskPath
			const cardsByPath = new Map<string, { card: KanbanCard; lane: KanbanLane }>();
			for (const lane of board.lanes) {
				for (const card of lane.cards) {
					if (card.baseTaskPath) {
						cardsByPath.set(card.baseTaskPath, { card, lane });
					}
				}
			}

			for (const task of tasks) {
				const existing = cardsByPath.get(task.path);
				
				if (existing) {
					// Update existing card
					const conflicts = await this.updateCardFromTask(existing.card, task, board, onConflict);
					if (conflicts.length > 0) {
						result.conflicts.push(...conflicts);
					}
					result.updated++;
				} else {
					// Create new card
					const lane = this.findLaneForTask(task, board);
					if (lane) {
						const newCard = this.createCardFromTask(task);
						lane.cards.push(newCard);
						result.created++;
					} else {
						// This shouldn't happen given the guard above, but log it just in case
						console.warn(`No lane found for task: ${task.path}`);
					}
				}
			}
		} catch (error) {
			result.errors.push(`Sync error: ${error}`);
		} finally {
			this.syncInProgress = false;
		}

		return result;
	}

	/**
	 * Find the appropriate lane for a task based on its status
	 */
	private findLaneForTask(task: BaseTask, board: KanbanBoard): KanbanLane | null {
		if (!task.status) {
			// Default to first lane if no status
			return board.lanes[0] || null;
		}

		// Reverse lookup: find lane title for this status
		for (const [laneTitle, status] of Object.entries(this.config.laneMapping)) {
			if (status.toLowerCase() === task.status.toLowerCase()) {
				const lane = board.lanes.find(l => l.title.toLowerCase() === laneTitle.toLowerCase());
				if (lane) return lane;
			}
		}

		// No mapping found, use first lane
		return board.lanes[0] || null;
	}

	/**
	 * Create a Kanban card from a Base task
	 */
	private createCardFromTask(task: BaseTask): KanbanCard {
		const card: KanbanCard = {
			id: this.generateId(),
			title: task.title,
			completed: task.completed || false,
			tags: task.tags || [],
			dueDate: task.dueDate,
			metadata: {
				progress: task.progress,
				project: task.project,
				priority: task.priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
				status: task.status,
			},
			baseTaskPath: task.path,
			baseSyncTime: Date.now(),
		};

		return card;
	}

	/**
	 * Update an existing card from a Base task
	 */
	private async updateCardFromTask(
		card: KanbanCard,
		task: BaseTask,
		board: KanbanBoard,
		onConflict?: (conflict: SyncConflict) => Promise<ConflictResolution | 'skip'>
	): Promise<SyncConflict[]> {
		const conflicts: SyncConflict[] = [];

		// Check for conflicts and update fields
		const fieldsToCheck = [
			{ field: 'title', local: card.title, remote: task.title },
			{ field: 'progress', local: card.metadata.progress, remote: task.progress },
			{ field: 'project', local: card.metadata.project, remote: task.project },
		];

		for (const { field, local, remote } of fieldsToCheck) {
			if (local !== remote && local !== undefined && remote !== undefined) {
				// Potential conflict
				const conflict: SyncConflict = {
					cardId: card.id,
					cardTitle: card.title,
					taskPath: task.path,
					localValue: String(local),
					remoteValue: String(remote),
					field,
				};

				let applyRemote = this.config.conflictResolution === 'remote';
				
				// Handle 'last-write' conflict resolution
				if (this.config.conflictResolution === 'last-write') {
					// Compare modification times: card's baseSyncTime vs task's modified time
					const cardModTime = card.baseSyncTime || 0;
					const taskModTime = task.modified || 0;
					applyRemote = taskModTime > cardModTime;
				} else if (this.config.conflictResolution === 'prompt' && onConflict) {
					const userChoice = await onConflict(conflict);
					if (userChoice === 'skip') continue;
					applyRemote = userChoice === 'remote';
				}

				if (applyRemote) {
					// Apply remote value
					if (field === 'title') card.title = remote as string;
					if (field === 'progress') card.metadata.progress = remote as number;
					if (field === 'project') card.metadata.project = remote as string;
				}

				conflicts.push(conflict);
			} else if (remote !== undefined && local === undefined) {
				// Remote has value, local doesn't - apply remote
				if (field === 'title') card.title = remote as string;
				if (field === 'progress') card.metadata.progress = remote as number;
				if (field === 'project') card.metadata.project = remote as string;
			}
		}

		// Update card's lane based on status
		const expectedLane = this.findLaneForTask(task, board);
		const currentLane = board.lanes.find(l => l.cards.some(c => c.id === card.id));
		
		if (expectedLane && currentLane && expectedLane.id !== currentLane.id) {
			// Move card to the correct lane (at the end to preserve local order)
			const cardIndex = currentLane.cards.findIndex(c => c.id === card.id);
			if (cardIndex >= 0) {
				currentLane.cards.splice(cardIndex, 1);
				expectedLane.cards.push(card);
			}
		}

		// Update sync time
		card.baseSyncTime = Date.now();

		return conflicts;
	}

	// ============ Helper Methods ============

	private generateId(): string {
		return Math.random().toString(36).substring(2, 11) + Date.now().toString(36).slice(-4);
	}

	/**
	 * Parse frontmatter from markdown content
	 */
	private parseFrontmatter(content: string): Record<string, any> | null {
		const match = content.match(/^---\n([\s\S]*?)\n---/);
		if (!match) return null;

		const frontmatter: Record<string, any> = {};
		const lines = match[1].split('\n');

		for (const line of lines) {
			const colonIndex = line.indexOf(':');
			if (colonIndex > 0) {
				const key = line.substring(0, colonIndex).trim();
				let value: any = line.substring(colonIndex + 1).trim();
				
				// Parse value types
				if (value === 'true') value = true;
				else if (value === 'false') value = false;
				else if (!isNaN(Number(value)) && value !== '') value = Number(value);
				else if (value.startsWith('[') && value.endsWith(']')) {
					// Simple array parsing
					value = value.slice(1, -1).split(',').map((s: string) => s.trim().replace(/['"]/g, ''));
				} else {
					// Remove quotes if present
					value = value.replace(/^['"]|['"]$/g, '');
				}
				
				frontmatter[key] = value;
			}
		}

		return frontmatter;
	}

	/**
	 * Update a single frontmatter field
	 */
	private updateFrontmatterField(content: string, field: string, value: string | number | boolean | undefined): string {
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
		
		if (!frontmatterMatch) {
			// No frontmatter, create it
			const valueStr = this.formatFrontmatterValue(value);
			return `---\n${field}: ${valueStr}\n---\n\n${content}`;
		}

		const frontmatterContent = frontmatterMatch[1];
		const lines = frontmatterContent.split('\n');
		let found = false;

		const newLines = lines.map(line => {
			const colonIndex = line.indexOf(':');
			if (colonIndex > 0) {
				const key = line.substring(0, colonIndex).trim();
				if (key === field) {
					found = true;
					if (value === undefined || value === '') {
						return null; // Remove the line
					}
					return `${field}: ${this.formatFrontmatterValue(value)}`;
				}
			}
			return line;
		}).filter(line => line !== null);

		if (!found && value !== undefined && value !== '') {
			newLines.push(`${field}: ${this.formatFrontmatterValue(value)}`);
		}

		return content.replace(frontmatterMatch[0], `---\n${newLines.join('\n')}\n---`);
	}

	/**
	 * Format a value for frontmatter
	 */
	private formatFrontmatterValue(value: string | number | boolean | undefined): string {
		if (value === undefined) return '';
		if (typeof value === 'boolean') return value.toString();
		if (typeof value === 'number') return value.toString();
		if (value.includes(':') || value.includes('#')) return `"${value}"`;
		return value;
	}

	/**
	 * Create file content with frontmatter
	 */
	private createFileWithFrontmatter(frontmatter: Record<string, any>, body: string): string {
		const lines = ['---'];
		
		for (const [key, value] of Object.entries(frontmatter)) {
			if (value !== undefined && value !== '') {
				lines.push(`${key}: ${this.formatFrontmatterValue(value)}`);
			}
		}
		
		lines.push('---', '', body);
		return lines.join('\n');
	}
}

// ============ Conflict Resolution Modal ============

export class ConflictResolutionModal extends Modal {
	private conflict: SyncConflict;
	private onResolve: (resolution: 'local' | 'remote' | 'skip') => void;

	constructor(app: App, conflict: SyncConflict, onResolve: (resolution: 'local' | 'remote' | 'skip') => void) {
		super(app);
		this.conflict = conflict;
		this.onResolve = onResolve;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('kanban-sync-conflict-modal');

		contentEl.createEl('h2', { text: 'Sync Conflict' });
		
		contentEl.createEl('p', { 
			text: `Conflict detected for "${this.conflict.cardTitle}" in field "${this.conflict.field}":` 
		});

		const comparisonEl = contentEl.createDiv({ cls: 'conflict-comparison' });
		
		const localEl = comparisonEl.createDiv({ cls: 'conflict-value local' });
		localEl.createEl('strong', { text: 'Local (Kanban):' });
		localEl.createEl('span', { text: this.conflict.localValue || '(empty)' });

		const remoteEl = comparisonEl.createDiv({ cls: 'conflict-value remote' });
		remoteEl.createEl('strong', { text: 'Remote (Base):' });
		remoteEl.createEl('span', { text: this.conflict.remoteValue || '(empty)' });

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Keep Local')
				.onClick(() => {
					this.onResolve('local');
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText('Use Remote')
				.setCta()
				.onClick(() => {
					this.onResolve('remote');
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText('Skip')
				.onClick(() => {
					this.onResolve('skip');
					this.close();
				}));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// ============ Base Task Picker Modal ============

export class BaseTaskPickerModal extends Modal {
	private tasksFolder: string;
	private onSelect: (taskPath: string | null) => void;
	private tasks: { path: string; title: string }[] = [];
	private filterEl: HTMLInputElement;
	private listEl: HTMLElement;

	constructor(app: App, tasksFolder: string, onSelect: (taskPath: string | null) => void) {
		super(app);
		this.tasksFolder = tasksFolder;
		this.onSelect = onSelect;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('kanban-task-picker-modal');

		contentEl.createEl('h2', { text: 'Link to Base Task' });

		// Filter input
		this.filterEl = contentEl.createEl('input', {
			type: 'text',
			cls: 'task-picker-filter',
			attr: { placeholder: 'Filter tasks...' }
		});

		this.filterEl.addEventListener('input', () => this.filterTasks());

		// Task list
		this.listEl = contentEl.createDiv({ cls: 'task-picker-list' });

		// Load tasks
		await this.loadTasks();
		this.renderTasks();

		// Focus filter
		this.filterEl.focus();

		// Cancel button
		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => {
					this.onSelect(null);
					this.close();
				}));
	}

	private async loadTasks(): Promise<void> {
		const folder = this.app.vault.getAbstractFileByPath(this.tasksFolder);
		if (!(folder instanceof TFolder)) return;

		const files = this.getMarkdownFiles(folder);
		
		for (const file of files) {
			const content = await this.app.vault.read(file);
			const titleMatch = content.match(/^---[\s\S]*?title:\s*(.+?)[\r\n]/m);
			const title = titleMatch ? titleMatch[1].replace(/['"]/g, '') : file.basename;
			this.tasks.push({ path: file.path, title });
		}

		// Sort by title
		this.tasks.sort((a, b) => a.title.localeCompare(b.title));
	}

	private getMarkdownFiles(folder: TFolder): TFile[] {
		const files: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') {
				files.push(child);
			} else if (child instanceof TFolder) {
				files.push(...this.getMarkdownFiles(child));
			}
		}
		return files;
	}

	private filterTasks(): void {
		this.renderTasks();
	}

	private renderTasks(): void {
		this.listEl.empty();
		const filter = this.filterEl.value.toLowerCase();

		const filteredTasks = this.tasks.filter(t => 
			t.title.toLowerCase().includes(filter) || 
			t.path.toLowerCase().includes(filter)
		);

		if (filteredTasks.length === 0) {
			this.listEl.createEl('p', { text: 'No tasks found', cls: 'task-picker-empty' });
			return;
		}

		for (const task of filteredTasks) {
			const taskEl = this.listEl.createDiv({ cls: 'task-picker-item' });
			taskEl.createEl('strong', { text: task.title });
			taskEl.createEl('span', { text: task.path, cls: 'task-path' });
			
			taskEl.addEventListener('click', () => {
				this.onSelect(task.path);
				this.close();
			});
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// ============ Sync Status Indicator ============

export function createSyncStatusElement(): HTMLElement {
	const statusEl = document.createElement('div');
	statusEl.className = 'kanban-sync-status';
	statusEl.style.display = 'none';
	return statusEl;
}

export function updateSyncStatus(statusEl: HTMLElement, status: 'syncing' | 'success' | 'error' | 'idle', message?: string): void {
	statusEl.className = `kanban-sync-status ${status}`;
	statusEl.style.display = status === 'idle' ? 'none' : 'flex';
	
	if (status === 'syncing') {
		statusEl.innerHTML = '<span class="sync-spinner"></span><span>Syncing...</span>';
	} else if (status === 'success') {
		statusEl.innerHTML = `<span>✓</span><span>${message || 'Synced'}</span>`;
		setTimeout(() => updateSyncStatus(statusEl, 'idle'), 2000);
	} else if (status === 'error') {
		statusEl.innerHTML = `<span>⚠</span><span>${message || 'Sync failed'}</span>`;
	}
}

