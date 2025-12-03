import {
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	TFile,
	TFolder,
	ViewState,
	WorkspaceLeaf,
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
import { BASIC_FRONTMATTER, hasFrontmatterKey, parseKanbanBoard } from './parser';

export default class KanbanPlugin extends Plugin {
	settings: KanbanPluginSettings;
	settingsTab: KanbanSettingTab;

	// Track view modes for files (kanban vs markdown)
	kanbanFileModes: Record<string, string> = {};

	// Reminder system
	private reminderIntervalId: number | null = null;
	private notifiedCards: Set<string> = new Set(); // Track cards already notified

	async onload(): Promise<void> {
		await this.loadSettings();

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
