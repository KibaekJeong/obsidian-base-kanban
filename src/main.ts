import {
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	TFile,
	TFolder,
	ViewState,
	WorkspaceLeaf,
	FuzzySuggestModal,
} from 'obsidian';

import { KanbanView } from './KanbanView';
import { KanbanSettingTab } from './settings';
import { 
	KanbanPluginSettings, 
	DEFAULT_SETTINGS, 
	KANBAN_VIEW_TYPE, 
	FRONTMATTER_KEY,
	KanbanCard,
} from './types';
import { BASIC_FRONTMATTER, hasFrontmatterKey, parseKanbanBoard, serializeKanbanBoard } from './parser';
import {
	queryGptTasks,
	createBoardFromGptTasks,
	getGptEpics,
	getGptProjects,
	updateGptTaskStatus,
	laneToStatus,
	isGptIntegrationConfigured,
	GptTask,
	GptTaskMetadata,
} from './GptTaskManagerIntegration';

/**
 * Public API for external plugin integration (e.g., GPT Task Manager)
 * This allows other plugins to interact with Base Kanban programmatically.
 */
export interface KanbanPublicAPI {
	/** Check if the plugin is ready */
	isReady(): boolean;
	
	/** Get the GPT Task Manager configuration */
	getGptConfig(): import('./types').GptTaskManagerConfig;
	
	/** Query GPT Task Manager tasks */
	queryTasks(filter?: {
		epic?: string;
		project?: string;
		status?: string[];
		includeCompleted?: boolean;
	}): Promise<GptTask[]>;
	
	/** Create a Kanban board from tasks */
	createBoardFromTasks(
		tasks: GptTask[],
		boardTitle?: string
	): import('./types').KanbanBoard;
	
	/** Create and open a board file */
	createAndOpenBoard(
		tasks: GptTask[],
		boardTitle: string
	): Promise<TFile>;
	
	/** Get available epics */
	getEpics(): Promise<string[]>;
	
	/** Get available projects */
	getProjects(): Promise<string[]>;
	
	/** Update a task's status */
	updateTaskStatus(
		taskPath: string,
		newStatus: string
	): Promise<boolean>;
	
	/** Register a callback for when a card moves between lanes */
	onCardMove(callback: (card: KanbanCard, fromLane: string, toLane: string) => void): () => void;
	
	/** Open a file in Kanban view */
	openInKanbanView(file: TFile): Promise<void>;
}

export default class KanbanPlugin extends Plugin {
	settings: KanbanPluginSettings;
	settingsTab: KanbanSettingTab;

	// Track view modes for files (kanban vs markdown)
	kanbanFileModes: Record<string, string> = {};

	// Reminder system
	private reminderIntervalId: number | null = null;
	private notifiedCards: Set<string> = new Set(); // Track cards already notified

	// Public API for external plugins
	public api: KanbanPublicAPI;
	
	// Card move callbacks for external plugins
	private cardMoveCallbacks: Set<(card: KanbanCard, fromLane: string, toLane: string) => void> = new Set();

	async onload(): Promise<void> {
		await this.loadSettings();

		// Initialize public API
		this.initializePublicAPI();

		// Register the kanban view
		this.registerView(KANBAN_VIEW_TYPE, (leaf) => new KanbanView(leaf, this));

		// Register extensions for .kanban files (optional)
		this.registerExtensions(['kanban'], KANBAN_VIEW_TYPE);

		// Add settings tab
		this.settingsTab = new KanbanSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		// Add ribbon icon
		this.addRibbonIcon('columns', 'Create new Kanban board', () => {
			this.createNewKanban();
		});

		// Register commands
		this.registerCommands();

		// Register file menu
		this.registerFileMenu();

		// Monkey patch to open kanban files in kanban view
		this.registerMonkeyPatch();

		// Register hover link source
		(this.app.workspace as any).registerHoverLinkSource?.(FRONTMATTER_KEY, {
			display: 'Kanban',
			defaultMod: true,
		});

		// Start reminder system if enabled
		if (this.settings['enable-reminders']) {
			this.startReminderCheck();
		}

		// Handle file renames to keep kanbanFileModes in sync
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (this.kanbanFileModes[oldPath]) {
					this.kanbanFileModes[file.path] = this.kanbanFileModes[oldPath];
					delete this.kanbanFileModes[oldPath];
				}
			})
		);

		// Handle file deletions to clean up kanbanFileModes
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (this.kanbanFileModes[file.path]) {
					delete this.kanbanFileModes[file.path];
				}
			})
		);
	}

	onunload(): void {
		// Clean up hover link source
		(this.app.workspace as any).unregisterHoverLinkSource?.(FRONTMATTER_KEY);
		
		// Stop reminder check
		this.stopReminderCheck();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Initialize the public API for external plugin integration
	 */
	private initializePublicAPI(): void {
		const plugin = this;
		
		this.api = {
			isReady(): boolean {
				return true;
			},
			
			getGptConfig(): import('./types').GptTaskManagerConfig {
				return plugin.settings['gpt-task-manager'];
			},
			
			async queryTasks(filter?: {
				epic?: string;
				project?: string;
				status?: string[];
				includeCompleted?: boolean;
			}): Promise<GptTask[]> {
				const gptConfig = plugin.settings['gpt-task-manager'];
				if (!isGptIntegrationConfigured(gptConfig)) {
					return [];
				}
				return queryGptTasks(plugin.app, gptConfig, filter);
			},
			
			createBoardFromTasks(
				tasks: GptTask[],
				boardTitle?: string
			): import('./types').KanbanBoard {
				const gptConfig = plugin.settings['gpt-task-manager'];
				return createBoardFromGptTasks(tasks, gptConfig, boardTitle);
			},
			
			async createAndOpenBoard(
				tasks: GptTask[],
				boardTitle: string
			): Promise<TFile> {
				const gptConfig = plugin.settings['gpt-task-manager'];
				const board = createBoardFromGptTasks(tasks, gptConfig, boardTitle);
				const file = await plugin.createBoardFile(board, boardTitle);
				return file;
			},
			
			async getEpics(): Promise<string[]> {
				const gptConfig = plugin.settings['gpt-task-manager'];
				if (!isGptIntegrationConfigured(gptConfig)) {
					return [];
				}
				return getGptEpics(plugin.app, gptConfig);
			},
			
			async getProjects(): Promise<string[]> {
				const gptConfig = plugin.settings['gpt-task-manager'];
				if (!isGptIntegrationConfigured(gptConfig)) {
					return [];
				}
				return getGptProjects(plugin.app, gptConfig);
			},
			
			async updateTaskStatus(
				taskPath: string,
				newStatus: string
			): Promise<boolean> {
				const gptConfig = plugin.settings['gpt-task-manager'];
				return updateGptTaskStatus(plugin.app, taskPath, newStatus, gptConfig);
			},
			
			onCardMove(callback: (card: KanbanCard, fromLane: string, toLane: string) => void): () => void {
				plugin.cardMoveCallbacks.add(callback);
				return () => {
					plugin.cardMoveCallbacks.delete(callback);
				};
			},
			
			async openInKanbanView(file: TFile): Promise<void> {
				plugin.kanbanFileModes[file.path] = KANBAN_VIEW_TYPE;
				const leaf = plugin.app.workspace.getLeaf(false);
				await leaf.setViewState({
					type: KANBAN_VIEW_TYPE,
					state: { file: file.path },
				});
			}
		};
	}

	/**
	 * Notify external plugins that a card has moved
	 */
	notifyCardMove(card: KanbanCard, fromLane: string, toLane: string): void {
		for (const callback of this.cardMoveCallbacks) {
			try {
				callback(card, fromLane, toLane);
			} catch (error) {
				console.error('Error in card move callback:', error);
			}
		}
	}

	private registerCommands(): void {
		// Create new kanban board
		this.addCommand({
			id: 'create-new-kanban-board',
			name: 'Create new board',
			callback: () => this.createNewKanban(),
		});

		// Toggle between kanban and markdown view
		this.addCommand({
			id: 'toggle-kanban-view',
			name: 'Toggle between Kanban and markdown mode',
			checkCallback: (checking) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return false;

				const fileCache = this.app.metadataCache.getFileCache(activeFile);
				const isKanban = fileCache?.frontmatter?.[FRONTMATTER_KEY];

				if (checking) return !!isKanban;

				const activeView = this.app.workspace.getActiveViewOfType(KanbanView);
				if (activeView) {
					this.kanbanFileModes[activeFile.path] = 'markdown';
					this.setMarkdownView(activeView.leaf);
				} else {
					const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (markdownView) {
						this.kanbanFileModes[activeFile.path] = KANBAN_VIEW_TYPE;
						this.setKanbanView(markdownView.leaf);
					}
				}
			},
		});

		// Archive completed cards
		this.addCommand({
			id: 'archive-completed-cards',
			name: 'Archive completed cards in active board',
			checkCallback: (checking) => {
				const activeView = this.app.workspace.getActiveViewOfType(KanbanView);
				if (!activeView) return false;
				if (checking) return true;
				activeView.archiveCompletedCards();
			},
		});

		// Convert empty note to kanban
		this.addCommand({
			id: 'convert-to-kanban',
			name: 'Convert empty note to Kanban',
			checkCallback: (checking) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView) return false;

				const isFileEmpty = activeView.file?.stat.size === 0;
				if (checking) return !!isFileEmpty;

				if (isFileEmpty && activeView.file) {
					this.app.vault
						.modify(activeView.file, BASIC_FRONTMATTER)
						.then(() => {
							this.setKanbanView(activeView.leaf);
						})
						.catch((error) => console.error('Error converting to kanban:', error));
				}
			},
		});

		// Add a list
		this.addCommand({
			id: 'add-kanban-lane',
			name: 'Add a list',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(KanbanView);
				if (!view) return false;
				if (checking) return true;
				view.addLane();
			},
		});

		// Open board settings
		this.addCommand({
			id: 'open-board-settings',
			name: 'Open board settings',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(KanbanView);
				if (!view) return false;
				if (checking) return true;
				(view as any).openBoardSettings?.();
			},
		});

		// Create or open card note
		this.addCommand({
			id: 'create-or-open-card-note',
			name: 'Create or open card note',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(KanbanView);
				if (!view) return false;
				if (checking) return true;
				view.createOrOpenCardNote();
			},
		});

		// Manual sync with Base
		this.addCommand({
			id: 'sync-with-base',
			name: 'Sync with Base',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(KanbanView);
				if (!view) return false;
				
				// Check if Base sync is enabled for this board
				const syncConfig = this.settings['base-sync'];
				if (!syncConfig.enabled) {
					if (!checking) {
						new Notice('Base sync is not enabled. Enable it in plugin settings first.');
					}
					return false;
				}
				
				if (checking) return true;
				view.manualSync();
			},
		});

		// ========== GPT Task Manager Integration Commands ==========

		// Create Kanban board from GPT Task Manager Epic
		this.addCommand({
			id: 'gpt-create-board-from-epic',
			name: 'GPT: Create Kanban board from Epic',
			callback: async () => {
				const gptConfig = this.settings['gpt-task-manager'];
				if (!isGptIntegrationConfigured(gptConfig)) {
					new Notice('GPT Task Manager integration is not enabled. Enable it in plugin settings.');
					return;
				}

				const epics = await getGptEpics(this.app, gptConfig);
				if (epics.length === 0) {
					new Notice(`No epics found in ${gptConfig.epicsFolder}`);
					return;
				}

				new EpicSelectorModal(this.app, epics, async (epicName) => {
					await this.createGptBoardFromEpic(epicName);
				}).open();
			},
		});

		// Create Kanban board from GPT Task Manager Project
		this.addCommand({
			id: 'gpt-create-board-from-project',
			name: 'GPT: Create Kanban board from Project',
			callback: async () => {
				const gptConfig = this.settings['gpt-task-manager'];
				if (!isGptIntegrationConfigured(gptConfig)) {
					new Notice('GPT Task Manager integration is not enabled. Enable it in plugin settings.');
					return;
				}

				const projects = await getGptProjects(this.app, gptConfig);
				if (projects.length === 0) {
					new Notice(`No projects found in ${gptConfig.projectsFolder}`);
					return;
				}

				new ProjectSelectorModal(this.app, projects, async (projectName) => {
					await this.createGptBoardFromProject(projectName);
				}).open();
			},
		});

		// Create Kanban board from all GPT Task Manager tasks
		this.addCommand({
			id: 'gpt-create-board-all-tasks',
			name: 'GPT: Create Kanban board from all tasks',
			callback: async () => {
				const gptConfig = this.settings['gpt-task-manager'];
				if (!isGptIntegrationConfigured(gptConfig)) {
					new Notice('GPT Task Manager integration is not enabled. Enable it in plugin settings.');
					return;
				}

				await this.createGptBoardFromAllTasks();
			},
		});

		// Refresh GPT Task Manager board
		this.addCommand({
			id: 'gpt-refresh-board',
			name: 'GPT: Refresh board with latest tasks',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(KanbanView);
				if (!view) return false;
				
				const gptConfig = this.settings['gpt-task-manager'];
				if (!isGptIntegrationConfigured(gptConfig)) return false;
				
				if (checking) return true;
				
				// Trigger a sync to refresh cards
				view.manualSync();
				new Notice('Board refreshed with latest GPT tasks');
			},
		});
	}

	private registerFileMenu(): void {
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file, source, leaf) => {
				if (source === 'link-context-menu') return;

				// Add "New kanban board" option in folder context menu
				if (file instanceof TFolder) {
					menu.addItem((item) => {
						item
							.setSection('action-primary')
							.setTitle('New kanban board')
							.setIcon('columns')
							.onClick(() => this.createNewKanban(file));
					});
					return;
				}

				// Add "Open as kanban" option for kanban files in markdown view
				if (file instanceof TFile && leaf) {
					const isMarkdownView = leaf.view instanceof MarkdownView;
					const isKanbanView = leaf.view instanceof KanbanView;
					const fileCache = this.app.metadataCache.getFileCache(file);
					const hasKanbanFrontmatter = fileCache?.frontmatter?.[FRONTMATTER_KEY];

					if (isMarkdownView && hasKanbanFrontmatter) {
						menu.addItem((item) => {
							item
								.setTitle('Open as kanban board')
								.setIcon('columns')
								.setSection('pane')
								.onClick(() => {
									this.kanbanFileModes[file.path] = KANBAN_VIEW_TYPE;
									this.setKanbanView(leaf);
								});
						});
					}

					if (isKanbanView) {
						menu.addItem((item) => {
							item
								.setTitle('Open as markdown')
								.setIcon('file-text')
								.setSection('pane')
								.onClick(() => {
									this.kanbanFileModes[file.path] = 'markdown';
									this.setMarkdownView(leaf);
								});
						});
					}
				}
			})
		);
	}

	private registerMonkeyPatch(): void {
		const self = this;

		// Monkey patch WorkspaceLeaf to open kanban files with KanbanView by default
		this.register(
			around(WorkspaceLeaf.prototype, {
				detach(next) {
					return function (this: WorkspaceLeaf) {
						const state = this.view?.getState();
						const stateFile = state?.file as string | undefined;
						// Clean up file mode tracking when leaf is detached
						if (stateFile && self.kanbanFileModes[stateFile]) {
							delete self.kanbanFileModes[stateFile];
						}
						return next.apply(this);
					};
				},

				setViewState(next) {
					return function (this: WorkspaceLeaf, state: ViewState, ...rest: any[]) {
						const stateFile = state.state?.file as string | undefined;
						if (
							state.type === 'markdown' &&
							stateFile &&
							self.kanbanFileModes[stateFile] !== 'markdown'
						) {
							const cache = self.app.metadataCache.getCache(stateFile);
							if (cache?.frontmatter?.[FRONTMATTER_KEY]) {
								const newState = {
									...state,
									type: KANBAN_VIEW_TYPE,
								};
								self.kanbanFileModes[stateFile] = KANBAN_VIEW_TYPE;
								return next.apply(this, [newState, ...rest]);
							}
						}
						return next.apply(this, [state, ...rest]);
					};
				},
			})
		);
	}

	async setMarkdownView(leaf: WorkspaceLeaf, focus: boolean = true): Promise<void> {
		await leaf.setViewState(
			{
				type: 'markdown',
				state: leaf.view.getState(),
				popstate: true,
			} as ViewState,
			{ focus }
		);
	}

	async setKanbanView(leaf: WorkspaceLeaf): Promise<void> {
		await leaf.setViewState({
			type: KANBAN_VIEW_TYPE,
			state: leaf.view.getState(),
			popstate: true,
		} as ViewState);
	}

	async createNewKanban(folder?: TFolder): Promise<void> {
		const targetFolder = folder || this.app.fileManager.getNewFileParent(
			this.app.workspace.getActiveFile()?.path || ''
		);

		let kanban: TFile | null = null;

		try {
			// Try the internal API first (preferred as it handles naming conflicts)
			kanban = await (this.app.fileManager as any).createNewMarkdownFile(
				targetFolder,
				'Untitled Kanban'
			);
		} catch (primaryError) {
			// Fallback to direct vault.create if internal API fails
			console.warn('Primary file creation failed, using fallback:', primaryError);
			try {
				const basePath = targetFolder.path ? `${targetFolder.path}/` : '';
				let filePath = `${basePath}Untitled Kanban.md`;
				let counter = 1;
				
				// Handle naming conflicts manually
				while (this.app.vault.getAbstractFileByPath(filePath)) {
					filePath = `${basePath}Untitled Kanban ${counter}.md`;
					counter++;
				}
				
				kanban = await this.app.vault.create(filePath, BASIC_FRONTMATTER);
			} catch (fallbackError) {
				console.error('Error creating kanban board:', fallbackError);
				new Notice('Error creating Kanban board');
				return;
			}
		}

		if (!kanban) {
			new Notice('Error creating Kanban board');
			return;
		}

		try {
			await this.app.vault.modify(kanban, BASIC_FRONTMATTER);
			await this.app.workspace.getLeaf().setViewState({
				type: KANBAN_VIEW_TYPE,
				state: { file: kanban.path },
			});

			new Notice('Created new Kanban board');
		} catch (error) {
			console.error('Error setting up kanban board:', error);
			new Notice('Error creating Kanban board');
		}
	}

	// ============ GPT Task Manager Integration ============

	/**
	 * Create a Kanban board from GPT Task Manager Epic
	 */
	async createGptBoardFromEpic(epicName: string): Promise<void> {
		const gptConfig = this.settings['gpt-task-manager'];
		
		new Notice(`Loading tasks for Epic: ${epicName}...`);
		
		const tasks = await queryGptTasks(this.app, gptConfig, {
			epic: epicName,
			includeCompleted: true,
		});

		if (tasks.length === 0) {
			new Notice(`No tasks found for Epic: ${epicName}`);
			return;
		}

		const board = createBoardFromGptTasks(tasks, gptConfig, `${epicName} Board`);
		await this.createBoardFile(board, `${epicName} Board`);
		
		new Notice(`Created Kanban board with ${tasks.length} tasks from Epic: ${epicName}`);
	}

	/**
	 * Create a Kanban board from GPT Task Manager Project
	 */
	async createGptBoardFromProject(projectName: string): Promise<void> {
		const gptConfig = this.settings['gpt-task-manager'];
		
		new Notice(`Loading tasks for Project: ${projectName}...`);
		
		const tasks = await queryGptTasks(this.app, gptConfig, {
			project: projectName,
			includeCompleted: true,
		});

		if (tasks.length === 0) {
			new Notice(`No tasks found for Project: ${projectName}`);
			return;
		}

		const board = createBoardFromGptTasks(tasks, gptConfig, `${projectName} Board`);
		await this.createBoardFile(board, `${projectName} Board`);
		
		new Notice(`Created Kanban board with ${tasks.length} tasks from Project: ${projectName}`);
	}

	/**
	 * Create a Kanban board from all GPT Task Manager tasks
	 */
	async createGptBoardFromAllTasks(): Promise<void> {
		const gptConfig = this.settings['gpt-task-manager'];
		
		new Notice('Loading all GPT tasks...');
		
		const tasks = await queryGptTasks(this.app, gptConfig, {
			includeCompleted: false,  // Exclude completed by default for "all tasks" view
		});

		if (tasks.length === 0) {
			new Notice('No active tasks found');
			return;
		}

		const board = createBoardFromGptTasks(tasks, gptConfig, 'All Tasks Board');
		await this.createBoardFile(board, 'All Tasks Board');
		
		new Notice(`Created Kanban board with ${tasks.length} active tasks`);
	}

	/**
	 * Create a Kanban board file from a board object
	 */
	private async createBoardFile(board: import('./types').KanbanBoard, title: string): Promise<TFile> {
		const targetFolder = this.app.fileManager.getNewFileParent(
			this.app.workspace.getActiveFile()?.path || ''
		);

		const basePath = targetFolder.path ? `${targetFolder.path}/` : '';
		let filePath = `${basePath}${title}.md`;
		let counter = 1;
		
		// Handle naming conflicts
		while (this.app.vault.getAbstractFileByPath(filePath)) {
			filePath = `${basePath}${title} ${counter}.md`;
			counter++;
		}

		const content = serializeKanbanBoard(board);
		const file = await this.app.vault.create(filePath, content);

		// Open the new board
		await this.app.workspace.getLeaf().setViewState({
			type: KANBAN_VIEW_TYPE,
			state: { file: file.path },
		});

		return file;
	}

	/**
	 * Update GPT Task Manager task status when a card moves between lanes
	 */
	async onCardMovedToLane(card: KanbanCard, newLaneTitle: string, oldLaneTitle?: string): Promise<void> {
		const gptConfig = this.settings['gpt-task-manager'];
		
		// Notify external plugins about the card move
		this.notifyCardMove(card, oldLaneTitle || '', newLaneTitle);
		
		if (!gptConfig.enabled || !gptConfig.updateStatusOnMove) return;
		if (!card.baseTaskPath) return;

		const newStatus = laneToStatus(newLaneTitle, gptConfig);
		const success = await updateGptTaskStatus(this.app, card.baseTaskPath, newStatus, gptConfig);
		
		if (success) {
			new Notice(`Updated task status to: ${newStatus}`);
		}
	}

	// ============ Reminder System ============

	startReminderCheck(): void {
		if (this.reminderIntervalId !== null) return;
		
		// Check every minute
		this.reminderIntervalId = window.setInterval(() => {
			this.checkReminders();
		}, 60 * 1000);
		
		// Also check immediately
		this.checkReminders();
	}

	stopReminderCheck(): void {
		if (this.reminderIntervalId !== null) {
			window.clearInterval(this.reminderIntervalId);
			this.reminderIntervalId = null;
		}
	}

	async checkReminders(): Promise<void> {
		if (!this.settings['enable-reminders']) return;

		const now = new Date();
		const kanbanFiles = this.app.vault.getMarkdownFiles().filter(file => {
			const cache = this.app.metadataCache.getFileCache(file);
			return cache?.frontmatter?.[FRONTMATTER_KEY];
		});

		for (const file of kanbanFiles) {
			try {
				const content = await this.app.vault.read(file);
				const board = parseKanbanBoard(content);
				
				for (const lane of board.lanes) {
					for (const card of lane.cards) {
						if (this.shouldRemind(card, now)) {
							this.showReminder(card, file.basename, lane.title);
						}
					}
				}
			} catch (error) {
				// Silently continue on parse errors
			}
		}
	}

	private shouldRemind(card: KanbanCard, now: Date): boolean {
		// Skip completed cards or cards without due date
		if (card.completed || !card.dueDate) return false;
		
		// Skip if already notified
		const notificationKey = `${card.id}-${card.dueDate}`;
		if (this.notifiedCards.has(notificationKey)) return false;
		
		// Parse due date/time
		const dueDateTime = this.parseDueDateTime(card);
		if (!dueDateTime) return false;
		
		// Get reminder offset
		const reminderTime = card.reminderTime || this.settings['reminder-time'] || '1h';
		const reminderOffsetMs = this.parseReminderOffset(reminderTime);
		
		// Calculate reminder time
		const reminderDateTime = new Date(dueDateTime.getTime() - reminderOffsetMs);
		
		// Check if we should remind now (within the reminder window and before/at due time)
		const shouldRemind = now >= reminderDateTime && now <= dueDateTime;
		
		if (shouldRemind) {
			this.notifiedCards.add(notificationKey);
		}
		
		return shouldRemind;
	}

	private parseDueDateTime(card: KanbanCard): Date | null {
		if (!card.dueDate) return null;
		
		try {
			const dateStr = card.dueDate;
			const timeStr = card.dueTime || '09:00'; // Default to 9 AM if no time specified
			
			const [year, month, day] = dateStr.split('-').map(Number);
			const [hours, minutes] = timeStr.split(':').map(Number);
			
			return new Date(year, month - 1, day, hours, minutes);
		} catch {
			return null;
		}
	}

	private parseReminderOffset(reminderTime: string): number {
		const match = reminderTime.match(/^(\d+)\s*(m|min|h|hr|d|day)s?$/i);
		if (!match) return 60 * 60 * 1000; // Default to 1 hour
		
		const value = parseInt(match[1], 10);
		const unit = match[2].toLowerCase();
		
		switch (unit) {
			case 'm':
			case 'min':
				return value * 60 * 1000;
			case 'h':
			case 'hr':
				return value * 60 * 60 * 1000;
			case 'd':
			case 'day':
				return value * 24 * 60 * 60 * 1000;
			default:
				return 60 * 60 * 1000;
		}
	}

	private showReminder(card: KanbanCard, boardName: string, laneName: string): void {
		const title = card.title.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1'); // Clean wiki links
		const dueStr = card.dueTime ? `${card.dueDate} ${card.dueTime}` : card.dueDate;
		
		const message = `📋 ${boardName} / ${laneName}\n"${title}"\nDue: ${dueStr}`;
		
		if (this.settings['reminder-type'] === 'system' && 'Notification' in window) {
			// Try system notification
			if (Notification.permission === 'granted') {
				new Notification('Kanban Reminder', {
					body: message,
					icon: 'columns',
				});
			} else if (Notification.permission !== 'denied') {
				Notification.requestPermission().then(permission => {
					if (permission === 'granted') {
						new Notification('Kanban Reminder', {
							body: message,
						});
					} else {
						// Fall back to Obsidian notice
						new Notice(message, 10000);
					}
				});
			} else {
				// Fall back to Obsidian notice
				new Notice(message, 10000);
			}
		} else {
			// Use Obsidian notice
			new Notice(message, 10000);
		}
	}

	// Clear notification history (called when settings change)
	clearNotificationHistory(): void {
		this.notifiedCards.clear();
	}

	// Restart reminder system (called when settings change)
	restartReminders(): void {
		this.stopReminderCheck();
		if (this.settings['enable-reminders']) {
			this.clearNotificationHistory();
			this.startReminderCheck();
		}
	}
}

// Utility function for monkey patching
function around<T extends object>(
	obj: T,
	factories: {
		[K in keyof T]?: (
			next: T[K]
		) => T[K];
	}
): () => void {
	const removers: Array<() => void> = [];

	for (const key in factories) {
		const original = obj[key];
		const factory = factories[key];

		if (factory && typeof original === 'function') {
			const wrapped = factory(original as any);
			obj[key] = wrapped as any;
			removers.push(() => {
				obj[key] = original;
			});
		}
	}

	return () => {
		for (const remover of removers) {
			remover();
		}
	};
}

/**
 * Modal for selecting an Epic to create a Kanban board from
 */
class EpicSelectorModal extends FuzzySuggestModal<string> {
	private epics: string[];
	private onChoose: (epic: string) => void;

	constructor(app: import('obsidian').App, epics: string[], onChoose: (epic: string) => void) {
		super(app);
		this.epics = epics;
		this.onChoose = onChoose;
		this.setPlaceholder('Select an Epic to create a Kanban board from...');
	}

	getItems(): string[] {
		return this.epics;
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string, evt: MouseEvent | KeyboardEvent): void {
		this.onChoose(item);
	}
}

/**
 * Modal for selecting a Project to create a Kanban board from
 */
class ProjectSelectorModal extends FuzzySuggestModal<string> {
	private projects: string[];
	private onChoose: (project: string) => void;

	constructor(app: import('obsidian').App, projects: string[], onChoose: (project: string) => void) {
		super(app);
		this.projects = projects;
		this.onChoose = onChoose;
		this.setPlaceholder('Select a Project to create a Kanban board from...');
	}

	getItems(): string[] {
		return this.projects;
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string, evt: MouseEvent | KeyboardEvent): void {
		this.onChoose(item);
	}
}
