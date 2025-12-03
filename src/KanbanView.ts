import { Menu, Modal, TextFileView, TFile, WorkspaceLeaf, setIcon, Setting, Notice } from 'obsidian';
import Sortable from 'sortablejs';
import { parseKanbanBoard, serializeKanbanBoard, createEmptyBoard, formatDate, prependArchiveDate, createCardFromTemplate, formatRelativeDate, serializeRecurrence, getNextOccurrence, updateSubtaskInContent, addSubtaskToContent, createTemplateContext, substituteTemplateVariables } from './parser';
import { KanbanBoard, KanbanCard, KanbanLane, BoardSettings, BaseTaskMetadata, KANBAN_VIEW_TYPE, DEFAULT_SETTINGS, RecurrencePattern, Subtask, BaseSyncConfig, DEFAULT_BASE_SYNC_CONFIG, BoardFilterState, DEFAULT_FILTER_STATE, DueStateFilter, LaneConfig, TemplateContext } from './types';
import { BaseSyncService, ConflictResolutionModal, BaseTaskPickerModal, SyncConflict, createSyncStatusElement, updateSyncStatus } from './BaseSync';
import type KanbanPlugin from './main';

export class KanbanView extends TextFileView {
	plugin: KanbanPlugin;
	board: KanbanBoard;
	boardContainer: HTMLElement;
	sortableInstances: Sortable[] = [];
	baseSyncService: BaseSyncService;
	syncStatusEl: HTMLElement;
	syncIntervalId: number | null = null;
	// Filter state (runtime only, not persisted)
	filterState: BoardFilterState = { ...DEFAULT_FILTER_STATE };
	filterToolbarEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: KanbanPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.board = createEmptyBoard();
		this.baseSyncService = new BaseSyncService(this.app);
		this.syncStatusEl = createSyncStatusElement();
		this.filterState = { ...DEFAULT_FILTER_STATE };
	}

	getViewType(): string {
		return KANBAN_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename || 'Kanban Board';
	}

	getIcon(): string {
		return 'columns';
	}

	getViewData(): string {
		return serializeKanbanBoard(this.board);
	}

	setViewData(data: string, clear: boolean): void {
		if (clear) {
			this.board = createEmptyBoard();
		}

		if (data.trim()) {
			this.board = parseKanbanBoard(data);
		}

		this.render();
	}

	clear(): void {
		this.board = createEmptyBoard();
		this.render();
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('kanban-plugin');

		this.boardContainer = container.createDiv({ cls: 'kanban-board-wrapper' });
		this.render();
	}

	async onClose(): Promise<void> {
		this.destroySortables();
		this.stopBackgroundSync();
	}

	onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);

		menu.addItem((item) => {
			item
				.setTitle('Add a list')
				.setIcon('plus-circle')
				.onClick(() => this.addLane());
		});

		menu.addItem((item) => {
			item
				.setTitle('Archive completed cards')
				.setIcon('archive')
				.onClick(() => this.archiveCompletedCards());
		});

		menu.addSeparator();

		menu.addItem((item) => {
			item
				.setTitle('Board settings')
				.setIcon('settings')
				.onClick(() => this.openBoardSettings());
		});
	}

	// Get effective setting (board-level overrides global)
	private getSetting<K extends keyof BoardSettings>(key: K): BoardSettings[K] {
		if (this.board.settings[key] !== undefined) {
			return this.board.settings[key];
		}
		// Fall back to plugin settings
		const pluginKey = key as keyof typeof DEFAULT_SETTINGS;
		if (pluginKey in this.plugin.settings) {
			return this.plugin.settings[pluginKey] as any;
		}
		return DEFAULT_SETTINGS[pluginKey] as any;
	}

	// Get Base sync configuration (board-level overrides global)
	private getBaseSyncConfig(): BaseSyncConfig {
		if (this.board.settings['base-sync']) {
			return { ...DEFAULT_BASE_SYNC_CONFIG, ...this.board.settings['base-sync'] };
		}
		return { ...this.plugin.settings['base-sync'] };
	}

	// ============ Base Sync Operations ============

	/**
	 * Start background sync if enabled
	 */
	private startBackgroundSync(): void {
		this.stopBackgroundSync();
		
		const config = this.getBaseSyncConfig();
		if (!config.enabled || config.syncInterval <= 0) return;

		const intervalMs = config.syncInterval * 60 * 1000;
		this.syncIntervalId = window.setInterval(() => {
			this.performBackgroundSync();
		}, intervalMs);
	}

	/**
	 * Stop background sync
	 */
	private stopBackgroundSync(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	/**
	 * Perform a background sync from Base
	 */
	async performBackgroundSync(): Promise<void> {
		const config = this.getBaseSyncConfig();
		if (!config.enabled) return;

		this.baseSyncService.setConfig(config);
		updateSyncStatus(this.syncStatusEl, 'syncing');

		try {
			const result = await this.baseSyncService.syncFromBase(this.board, async (conflict) => {
				if (config.conflictResolution === 'prompt') {
					return await this.promptConflictResolution(conflict);
				}
				return config.conflictResolution;
			});

			if (result.errors.length > 0) {
				updateSyncStatus(this.syncStatusEl, 'error', result.errors[0]);
				new Notice(`Sync error: ${result.errors[0]}`);
			} else {
				const msg = `Synced: ${result.created} created, ${result.updated} updated`;
				updateSyncStatus(this.syncStatusEl, 'success', msg);
				
				if (result.created > 0 || result.updated > 0) {
					this.requestSave();
					this.render();
				}
			}
		} catch (error) {
			updateSyncStatus(this.syncStatusEl, 'error', 'Sync failed');
			console.error('Base sync error:', error);
		}
	}

	/**
	 * Prompt user to resolve a conflict
	 */
	private async promptConflictResolution(conflict: SyncConflict): Promise<'local' | 'remote' | 'skip'> {
		return new Promise((resolve) => {
			const modal = new ConflictResolutionModal(this.app, conflict, (resolution) => {
				resolve(resolution);
			});
			modal.open();
		});
	}

	/**
	 * Manual sync trigger
	 */
	async manualSync(): Promise<void> {
		await this.performBackgroundSync();
	}

	/**
	 * Link a card to an existing Base task
	 */
	async linkCardToBaseTask(card: KanbanCard): Promise<void> {
		const config = this.getBaseSyncConfig();
		if (!config.enabled) {
			new Notice('Base sync is not enabled. Enable it in settings first.');
			return;
		}

		// Show file picker modal
		const modal = new BaseTaskPickerModal(this.app, config.tasksFolder, async (taskPath) => {
			if (taskPath) {
				card.baseTaskPath = taskPath;
				card.baseSyncTime = Date.now();
				this.requestSave();
				this.render();
				new Notice(`Card linked to: ${taskPath}`);
			}
		});
		modal.open();
	}

	/**
	 * Create a Base task for a card
	 */
	async createBaseTaskForCard(card: KanbanCard, lane: KanbanLane): Promise<void> {
		const config = this.getBaseSyncConfig();
		if (!config.enabled) {
			new Notice('Base sync is not enabled. Enable it in settings first.');
			return;
		}

		this.baseSyncService.setConfig(config);
		const taskPath = await this.baseSyncService.createBaseTask(card.title, card.metadata, lane);
		
		if (taskPath) {
			card.baseTaskPath = taskPath;
			card.baseSyncTime = Date.now();
			this.requestSave();
			this.render();
			new Notice(`Created Base task: ${taskPath}`);
		} else {
			new Notice('Failed to create Base task');
		}
	}

	private destroySortables(): void {
		for (const sortable of this.sortableInstances) {
			sortable.destroy();
		}
		this.sortableInstances = [];
	}

	private render(): void {
		if (!this.boardContainer) return;

		this.destroySortables();
		this.boardContainer.empty();

		// Apply lane width CSS variable
		const laneWidth = this.getSetting('lane-width') || this.plugin.settings['default-lane-width'];
		this.boardContainer.style.setProperty('--kanban-lane-width', laneWidth);

		// Add sync toolbar if Base sync is enabled
		const syncConfig = this.getBaseSyncConfig();
		if (syncConfig.enabled) {
			this.renderSyncToolbar();
		}

		// Add filter toolbar if enabled
		const showFilterToolbar = this.getSetting('show-filter-toolbar') !== false;
		if (showFilterToolbar) {
			this.renderFilterToolbar();
		}

		const boardEl = this.boardContainer.createDiv({ cls: 'kanban-board' });

		// Render lanes (with filtering applied)
		for (const lane of this.board.lanes) {
			this.renderLane(boardEl, lane);
		}

		// Add "Add Lane" button if setting enabled
		const showAddList = this.getSetting('show-add-list') !== false;
		if (showAddList) {
			const addLaneBtn = boardEl.createDiv({ cls: 'kanban-add-lane-btn' });
			addLaneBtn.createSpan({ text: '+ Add list' });
			addLaneBtn.addEventListener('click', () => this.addLane());
		}

		// Setup lane drag and drop
		this.setupLaneSortable(boardEl);

		// Start background sync if enabled
		this.startBackgroundSync();
	}

	private renderSyncToolbar(): void {
		const toolbarEl = this.boardContainer.createDiv({ cls: 'kanban-sync-toolbar' });
		
		// Sync status indicator
		toolbarEl.appendChild(this.syncStatusEl);
		
		// Sync button
		const syncBtn = toolbarEl.createDiv({ cls: 'kanban-sync-btn' });
		setIcon(syncBtn, 'refresh-cw');
		syncBtn.title = 'Sync with Base';
		syncBtn.addEventListener('click', () => this.manualSync());
		
		// Base indicator
		const baseIndicator = toolbarEl.createDiv({ cls: 'kanban-base-indicator' });
		setIcon(baseIndicator, 'database');
		baseIndicator.createSpan({ text: 'Base sync enabled' });
	}

	private renderFilterToolbar(): void {
		this.filterToolbarEl = this.boardContainer.createDiv({ cls: 'kanban-filter-toolbar' });
		
		// Search input
		const searchContainer = this.filterToolbarEl.createDiv({ cls: 'filter-search-container' });
		const searchIcon = searchContainer.createSpan({ cls: 'filter-search-icon' });
		setIcon(searchIcon, 'search');
		
		const searchInput = searchContainer.createEl('input', {
			type: 'text',
			cls: 'filter-search-input',
			attr: { placeholder: 'Search cards...' }
		});
		searchInput.value = this.filterState.text;
		searchInput.addEventListener('input', () => {
			this.filterState.text = searchInput.value;
			this.applyFilters();
		});

		// Filter buttons container
		const filtersContainer = this.filterToolbarEl.createDiv({ cls: 'filter-buttons' });

		// Tag filter dropdown
		const tagBtn = filtersContainer.createDiv({ cls: 'filter-btn' });
		setIcon(tagBtn, 'tag');
		tagBtn.createSpan({ text: 'Tags' });
		if (this.filterState.tags.length > 0) {
			tagBtn.addClass('has-filter');
			tagBtn.createSpan({ cls: 'filter-badge', text: String(this.filterState.tags.length) });
		}
		tagBtn.addEventListener('click', (e) => this.showTagFilterMenu(e));

		// Project filter dropdown
		const projectBtn = filtersContainer.createDiv({ cls: 'filter-btn' });
		setIcon(projectBtn, 'folder');
		projectBtn.createSpan({ text: 'Project' });
		if (this.filterState.projects.length > 0) {
			projectBtn.addClass('has-filter');
			projectBtn.createSpan({ cls: 'filter-badge', text: String(this.filterState.projects.length) });
		}
		projectBtn.addEventListener('click', (e) => this.showProjectFilterMenu(e));

		// Due date filter dropdown
		const dueBtn = filtersContainer.createDiv({ cls: 'filter-btn' });
		setIcon(dueBtn, 'calendar');
		dueBtn.createSpan({ text: 'Due' });
		if (this.filterState.dueState !== 'all') {
			dueBtn.addClass('has-filter');
		}
		dueBtn.addEventListener('click', (e) => this.showDueFilterMenu(e));

		// Show/hide completed toggle
		const completedBtn = filtersContainer.createDiv({ 
			cls: `filter-btn ${this.filterState.showCompleted ? '' : 'has-filter'}` 
		});
		setIcon(completedBtn, this.filterState.showCompleted ? 'check-circle' : 'circle');
		completedBtn.createSpan({ text: this.filterState.showCompleted ? 'Showing completed' : 'Hiding completed' });
		completedBtn.addEventListener('click', () => {
			this.filterState.showCompleted = !this.filterState.showCompleted;
			this.applyFilters();
		});

		// Clear filters button (only show if filters are active)
		if (this.hasActiveFilters()) {
			const clearBtn = filtersContainer.createDiv({ cls: 'filter-btn filter-clear-btn' });
			setIcon(clearBtn, 'x');
			clearBtn.createSpan({ text: 'Clear filters' });
			clearBtn.addEventListener('click', () => this.clearFilters());
		}

		// Filter count indicator
		const filteredCount = this.getFilteredCardCount();
		const totalCount = this.getTotalCardCount();
		if (this.hasActiveFilters()) {
			const countEl = this.filterToolbarEl.createDiv({ cls: 'filter-count' });
			countEl.textContent = `Showing ${filteredCount} of ${totalCount} cards`;
		}
	}

	private showTagFilterMenu(event: MouseEvent): void {
		const menu = new Menu();
		const allTags = this.getAllTags();

		if (allTags.length === 0) {
			menu.addItem((item) => {
				item.setTitle('No tags found').setDisabled(true);
			});
		} else {
			for (const tag of allTags) {
				const isSelected = this.filterState.tags.includes(tag);
				menu.addItem((item) => {
					item
						.setTitle(`${isSelected ? '✓ ' : ''}#${tag}`)
						.onClick(() => {
							if (isSelected) {
								this.filterState.tags = this.filterState.tags.filter(t => t !== tag);
							} else {
								this.filterState.tags.push(tag);
							}
							this.applyFilters();
						});
				});
			}
			
			if (this.filterState.tags.length > 0) {
				menu.addSeparator();
				menu.addItem((item) => {
					item.setTitle('Clear tag filter').onClick(() => {
						this.filterState.tags = [];
						this.applyFilters();
					});
				});
			}
		}

		menu.showAtMouseEvent(event);
	}

	private showProjectFilterMenu(event: MouseEvent): void {
		const menu = new Menu();
		const allProjects = this.getAllProjects();

		if (allProjects.length === 0) {
			menu.addItem((item) => {
				item.setTitle('No projects found').setDisabled(true);
			});
		} else {
			for (const project of allProjects) {
				const isSelected = this.filterState.projects.includes(project);
				menu.addItem((item) => {
					item
						.setTitle(`${isSelected ? '✓ ' : ''}${project}`)
						.onClick(() => {
							if (isSelected) {
								this.filterState.projects = this.filterState.projects.filter(p => p !== project);
							} else {
								this.filterState.projects.push(project);
							}
							this.applyFilters();
						});
				});
			}
			
			if (this.filterState.projects.length > 0) {
				menu.addSeparator();
				menu.addItem((item) => {
					item.setTitle('Clear project filter').onClick(() => {
						this.filterState.projects = [];
						this.applyFilters();
					});
				});
			}
		}

		menu.showAtMouseEvent(event);
	}

	private showDueFilterMenu(event: MouseEvent): void {
		const menu = new Menu();
		const dueOptions: { value: DueStateFilter; label: string }[] = [
			{ value: 'all', label: 'All cards' },
			{ value: 'overdue', label: 'Overdue' },
			{ value: 'due-today', label: 'Due today' },
			{ value: 'due-week', label: 'Due this week' },
			{ value: 'has-date', label: 'Has due date' },
			{ value: 'no-date', label: 'No due date' },
		];

		for (const opt of dueOptions) {
			const isSelected = this.filterState.dueState === opt.value;
			menu.addItem((item) => {
				item
					.setTitle(`${isSelected ? '✓ ' : ''}${opt.label}`)
					.onClick(() => {
						this.filterState.dueState = opt.value;
						this.applyFilters();
					});
			});
		}

		menu.showAtMouseEvent(event);
	}

	private getAllTags(): string[] {
		const tags = new Set<string>();
		for (const lane of this.board.lanes) {
			for (const card of lane.cards) {
				for (const tag of card.tags) {
					tags.add(tag);
				}
			}
		}
		return Array.from(tags).sort();
	}

	private getAllProjects(): string[] {
		const projects = new Set<string>();
		for (const lane of this.board.lanes) {
			for (const card of lane.cards) {
				if (card.metadata.project) {
					projects.add(card.metadata.project);
				}
			}
		}
		return Array.from(projects).sort();
	}

	private hasActiveFilters(): boolean {
		return this.filterState.text !== '' ||
			this.filterState.tags.length > 0 ||
			this.filterState.projects.length > 0 ||
			this.filterState.dueState !== 'all' ||
			!this.filterState.showCompleted;
	}

	private clearFilters(): void {
		this.filterState = { ...DEFAULT_FILTER_STATE };
		this.applyFilters();
	}

	private applyFilters(): void {
		// Just re-render, the filter logic is in cardMatchesFilter
		this.render();
	}

	private cardMatchesFilter(card: KanbanCard): boolean {
		// Text search
		if (this.filterState.text) {
			const searchText = this.filterState.text.toLowerCase();
			const titleMatch = card.title.toLowerCase().includes(searchText);
			const notesMatch = card.notes?.toLowerCase().includes(searchText) || false;
			const contentMatch = card.content?.toLowerCase().includes(searchText) || false;
			if (!titleMatch && !notesMatch && !contentMatch) {
				return false;
			}
		}

		// Tag filter (OR)
		if (this.filterState.tags.length > 0) {
			const hasMatchingTag = this.filterState.tags.some(tag => card.tags.includes(tag));
			if (!hasMatchingTag) {
				return false;
			}
		}

		// Project filter (OR)
		if (this.filterState.projects.length > 0) {
			if (!card.metadata.project || !this.filterState.projects.includes(card.metadata.project)) {
				return false;
			}
		}

		// Completed filter
		if (!this.filterState.showCompleted && card.completed) {
			return false;
		}

		// Due state filter
		if (this.filterState.dueState !== 'all') {
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const cardDate = card.dueDate ? new Date(card.dueDate) : null;
			if (cardDate) cardDate.setHours(0, 0, 0, 0);

			switch (this.filterState.dueState) {
				case 'overdue':
					if (!cardDate || cardDate >= today) return false;
					break;
				case 'due-today':
					if (!cardDate || cardDate.getTime() !== today.getTime()) return false;
					break;
				case 'due-week': {
					const weekEnd = new Date(today);
					weekEnd.setDate(weekEnd.getDate() + 7);
					if (!cardDate || cardDate < today || cardDate > weekEnd) return false;
					break;
				}
				case 'has-date':
					if (!card.dueDate) return false;
					break;
				case 'no-date':
					if (card.dueDate) return false;
					break;
			}
		}

		// Priority filter
		if (this.filterState.priority && card.metadata.priority !== this.filterState.priority) {
			return false;
		}

		return true;
	}

	private getFilteredCards(lane: KanbanLane): KanbanCard[] {
		if (!this.hasActiveFilters()) {
			return lane.cards;
		}
		return lane.cards.filter(card => this.cardMatchesFilter(card));
	}

	private getFilteredCardCount(): number {
		let count = 0;
		for (const lane of this.board.lanes) {
			count += this.getFilteredCards(lane).length;
		}
		return count;
	}

	private getTotalCardCount(): number {
		let count = 0;
		for (const lane of this.board.lanes) {
			count += lane.cards.length;
		}
		return count;
	}

	private renderLane(boardEl: HTMLElement, lane: KanbanLane): void {
		// Get WIP limit config for this lane
		const wipConfig = this.getLaneWipConfig(lane);
		const cardCount = lane.cards.length;
		const isOverLimit = wipConfig.limit > 0 && cardCount > wipConfig.limit;
		const isAtWarning = wipConfig.limit > 0 && wipConfig.warnAt && cardCount >= wipConfig.warnAt;
		
		// Build lane classes
		const laneClasses = ['kanban-lane'];
		if (isOverLimit) laneClasses.push('wip-exceeded');
		else if (isAtWarning) laneClasses.push('wip-warning');
		
		const laneEl = boardEl.createDiv({ cls: laneClasses.join(' '), attr: { 'data-lane-id': lane.id } });

		// Lane header
		const headerEl = laneEl.createDiv({ cls: 'kanban-lane-header' });
		
		const titleContainer = headerEl.createDiv({ cls: 'kanban-lane-title-container' });
		const titleEl = titleContainer.createSpan({ cls: 'kanban-lane-title', text: lane.title });
		titleEl.contentEditable = 'true';
		titleEl.addEventListener('blur', () => {
			lane.title = titleEl.textContent || 'Untitled';
			this.requestSave();
		});
		titleEl.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				titleEl.blur();
			}
		});

		// Card count with WIP limit indicator
		const hideCount = this.getSetting('hide-card-count');
		if (!hideCount) {
			const filteredCards = this.getFilteredCards(lane);
			const countText = wipConfig.limit > 0 
				? `${cardCount}/${wipConfig.limit}` 
				: `${cardCount}`;
			
			const countClasses = ['kanban-lane-count'];
			if (isOverLimit) countClasses.push('over-limit');
			else if (isAtWarning) countClasses.push('at-warning');
			
			const countEl = titleContainer.createSpan({ cls: countClasses.join(' '), text: countText });
			
			// Show filtered indicator if filtering is active
			if (this.hasActiveFilters() && filteredCards.length !== lane.cards.length) {
				countEl.title = `${filteredCards.length} visible, ${lane.cards.length} total`;
			}
		}

		// Lane menu
		const menuBtn = headerEl.createDiv({ cls: 'kanban-lane-menu-btn' });
		setIcon(menuBtn, 'more-vertical');
		menuBtn.addEventListener('click', (event: MouseEvent) => {
			event.stopPropagation();
			this.showLaneMenu(event, lane);
		});

		// Quick-add composer settings
		const showComposer = this.getSetting('show-card-composer') !== false;
		const composerPosition = this.getSetting('composer-position') || this.plugin.settings['composer-position'] || 'bottom';
		const canAddCards = !wipConfig.blockExceeded || !isOverLimit;

		// Composer at top
		if (showComposer && composerPosition === 'top') {
			this.renderCardComposer(laneEl, lane, canAddCards);
		}

		// Cards container
		const cardsEl = laneEl.createDiv({ cls: 'kanban-lane-cards', attr: { 'data-lane-id': lane.id } });
		
		// Render filtered cards
		const filteredCards = this.getFilteredCards(lane);
		for (const card of filteredCards) {
			this.renderCard(cardsEl, card, lane);
		}

		// Show "hidden by filter" indicator if some cards are hidden
		if (this.hasActiveFilters() && filteredCards.length < lane.cards.length) {
			const hiddenCount = lane.cards.length - filteredCards.length;
			const hiddenEl = cardsEl.createDiv({ cls: 'kanban-hidden-cards-indicator' });
			hiddenEl.textContent = `${hiddenCount} card${hiddenCount > 1 ? 's' : ''} hidden by filter`;
		}

		// Composer at bottom (default)
		if (showComposer && composerPosition === 'bottom') {
			this.renderCardComposer(laneEl, lane, canAddCards);
		}

		// Add card button (shown if composer is disabled)
		if (!showComposer) {
			const addCardBtn = laneEl.createDiv({ cls: `kanban-add-card-btn ${canAddCards ? '' : 'disabled'}` });
			addCardBtn.createSpan({ text: '+ Add card' });
			if (canAddCards) {
				addCardBtn.addEventListener('click', () => this.addCard(lane));
			} else {
				addCardBtn.title = 'WIP limit exceeded';
			}
		}

		// Setup card drag and drop
		this.setupCardSortable(cardsEl, lane);
	}

	private getLaneWipConfig(lane: KanbanLane): { limit: number; warnAt?: number; blockExceeded: boolean } {
		// Check for lane-specific config
		const laneConfigs = this.board.settings['lane-configs'] || {};
		const laneConfig = laneConfigs[lane.title] || laneConfigs[lane.id];
		
		if (laneConfig?.wipLimit) {
			return {
				limit: laneConfig.wipLimit.limit,
				warnAt: laneConfig.wipLimit.warnAt || laneConfig.wipLimit.limit,
				blockExceeded: laneConfig.wipLimit.blockExceeded,
			};
		}
		
		// Fall back to global defaults
		const defaultLimit = this.plugin.settings['default-wip-limit'] || 0;
		const blockExceeded = this.plugin.settings['wip-block-exceeded'] || false;
		
		return {
			limit: defaultLimit,
			warnAt: defaultLimit,
			blockExceeded,
		};
	}

	private renderCardComposer(laneEl: HTMLElement, lane: KanbanLane, canAddCards: boolean = true): void {
		const composerEl = laneEl.createDiv({ cls: `kanban-card-composer ${canAddCards ? '' : 'disabled'}` });
		
		const textarea = composerEl.createEl('textarea', {
			cls: 'kanban-composer-input',
			attr: { 
				placeholder: canAddCards ? 'Add a card... (Enter to add, Shift+Enter for newline)' : 'WIP limit exceeded',
				rows: '1',
				disabled: canAddCards ? undefined : 'disabled'
			}
		});

		if (!canAddCards) {
			composerEl.title = 'WIP limit exceeded - cannot add more cards';
			return;
		}

		// Auto-resize textarea
		const autoResize = () => {
			textarea.style.height = 'auto';
			textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
		};

		textarea.addEventListener('input', autoResize);

		textarea.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				if (event.shiftKey) {
					// Shift+Enter: allow newline
					return;
				} else {
					// Enter: add card
					event.preventDefault();
					const text = textarea.value.trim();
					if (text) {
						this.addCardFromComposer(lane, text);
						textarea.value = '';
						autoResize();
					}
				}
			} else if (event.key === 'Escape') {
				textarea.value = '';
				textarea.blur();
				autoResize();
			}
		});

		// Show add button when there's content
		const addBtn = composerEl.createDiv({ cls: 'kanban-composer-add-btn' });
		setIcon(addBtn, 'plus');
		addBtn.addEventListener('click', () => {
			const text = textarea.value.trim();
			if (text) {
				this.addCardFromComposer(lane, text);
				textarea.value = '';
				autoResize();
			}
		});
	}

	private async addCardFromComposer(lane: KanbanLane, text: string): Promise<void> {
		const lines = text.split('\n');
		const title = lines[0].trim();
		const contentLines = lines.slice(1);
		
		// Parse subtasks and content from additional lines
		const subtasks: Subtask[] = [];
		const otherContent: string[] = [];
		
		for (const line of contentLines) {
			const subtaskMatch = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
			if (subtaskMatch) {
				subtasks.push({
					id: Math.random().toString(36).substring(2, 11) + Date.now().toString(36).slice(-4),
					text: subtaskMatch[2].trim(),
					completed: subtaskMatch[1].toLowerCase() === 'x',
				});
			} else if (line.trim()) {
				otherContent.push(line);
			}
		}

		const defaultProject = this.getSetting('default-project');
		
		const newCard: KanbanCard = {
			id: Math.random().toString(36).substring(2, 11) + Date.now().toString(36).slice(-4),
			title: title || 'New card',
			completed: false,
			tags: [],
			metadata: defaultProject ? { project: defaultProject } : {},
			subtasks: subtasks.length > 0 ? subtasks : undefined,
			content: contentLines.length > 0 ? contentLines.map(l => '\t' + l).join('\n') : undefined,
		};

		// Parse tags, dates, etc. from title
		const tagMatches = title.match(/#[\w-/]+/g) || [];
		newCard.tags = tagMatches.map(tag => tag.substring(1));

		const dateMatch = title.match(/@(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
		if (dateMatch) {
			newCard.dueDate = dateMatch[1];
			newCard.dueTime = dateMatch[2];
		}

		const insertMethod = this.getSetting('new-card-insertion-method') || this.plugin.settings['new-card-insertion-method'];
		if (insertMethod === 'prepend') {
			lane.cards.unshift(newCard);
		} else {
			lane.cards.push(newCard);
		}

		this.requestSave();
		this.render();

		// Auto-create note if enabled (immediate since title is already known)
		const autoCreateNote = this.getSetting('auto-create-note') || this.plugin.settings['auto-create-note'];
		if (autoCreateNote && title) {
			await this.createCardNote(newCard);
		}
	}

	private renderSubtasks(container: HTMLElement, card: KanbanCard, lane: KanbanLane): void {
		if (!card.subtasks || card.subtasks.length === 0) return;

		const subtasksEl = container.createDiv({ cls: 'kanban-card-subtasks' });
		
		// Progress indicator
		const completed = card.subtasks.filter(s => s.completed).length;
		const total = card.subtasks.length;
		const progressEl = subtasksEl.createDiv({ cls: 'kanban-subtasks-progress' });
		progressEl.createSpan({ cls: 'subtask-count', text: `${completed}/${total}` });
		
		const progressBar = progressEl.createDiv({ cls: 'subtask-progress-bar' });
		const progressFill = progressBar.createDiv({ cls: 'subtask-progress-fill' });
		progressFill.style.width = `${(completed / total) * 100}%`;
		
		if (completed === total) {
			progressEl.addClass('all-complete');
		}

		// Subtask list
		const listEl = subtasksEl.createDiv({ cls: 'kanban-subtasks-list' });
		
		card.subtasks.forEach((subtask, index) => {
			const subtaskEl = listEl.createDiv({ 
				cls: `kanban-subtask ${subtask.completed ? 'is-completed' : ''}` 
			});
			
			const checkbox = subtaskEl.createEl('input', { type: 'checkbox' });
			checkbox.checked = subtask.completed;
			checkbox.addEventListener('change', (e) => {
				e.stopPropagation();
				subtask.completed = checkbox.checked;
				subtaskEl.toggleClass('is-completed', subtask.completed);
				
				// Update content if it exists
				if (card.content) {
					card.content = updateSubtaskInContent(card.content, index, subtask.completed);
				}
				
				// Update progress display
				const newCompleted = card.subtasks!.filter(s => s.completed).length;
				const countEl = progressEl.querySelector('.subtask-count');
				if (countEl) countEl.textContent = `${newCompleted}/${total}`;
				progressFill.style.width = `${(newCompleted / total) * 100}%`;
				progressEl.toggleClass('all-complete', newCompleted === total);
				
				this.requestSave();
			});
			
			subtaskEl.createSpan({ cls: 'subtask-text', text: subtask.text });
		});
	}

	private renderCard(cardsEl: HTMLElement, card: KanbanCard, lane: KanbanLane): void {
		const cardClasses = ['kanban-card'];
		if (card.completed) cardClasses.push('is-completed');
		if (card.baseTaskPath) cardClasses.push('has-base-task');
		
		const cardEl = cardsEl.createDiv({ 
			cls: cardClasses.join(' '),
			attr: { 'data-card-id': card.id }
		});

		// Base task indicator
		if (card.baseTaskPath) {
			const baseIndicator = cardEl.createDiv({ cls: 'kanban-base-link-indicator' });
			baseIndicator.title = `Linked to: ${card.baseTaskPath}`;
		}

		// Card checkbox
		const showCheckboxes = this.getSetting('show-checkboxes') !== false;
		if (showCheckboxes) {
			const checkboxContainer = cardEl.createDiv({ cls: 'kanban-card-checkbox' });
			const checkbox = checkboxContainer.createEl('input', { type: 'checkbox' });
			checkbox.checked = card.completed;
			checkbox.addEventListener('change', () => {
				card.completed = checkbox.checked;
				cardEl.toggleClass('is-completed', card.completed);
				this.requestSave();
			});
		}

		// Card content
		const contentEl = cardEl.createDiv({ cls: 'kanban-card-content' });
		
		// Title (with display options)
		const displayTitle = this.getDisplayTitle(card);
		const titleEl = contentEl.createDiv({ cls: 'kanban-card-title' });
		titleEl.innerHTML = this.renderCardTitleHTML(displayTitle, card);
		
		// Make title editable
		const titleTextEl = titleEl.querySelector('.kanban-card-title-text') as HTMLElement;
		if (titleTextEl) {
			titleTextEl.contentEditable = 'true';
			titleTextEl.addEventListener('blur', async () => {
				// Preserve tags and dates in title
				const newText = titleTextEl.textContent || '';
				card.title = this.reconstructCardTitle(newText, card);
				this.requestSave();
				
				// Check for pending auto-create note
				if (this.pendingAutoCreateNote && this.pendingAutoCreateNote.card.id === card.id) {
					const pending = this.pendingAutoCreateNote;
					this.pendingAutoCreateNote = null;
					if (card.title && card.title !== 'New card') {
						await this.createCardNote(pending.card);
					}
				}
			});
			titleTextEl.addEventListener('keydown', (event: KeyboardEvent) => {
				if (event.key === 'Enter' && !event.shiftKey) {
					event.preventDefault();
					titleTextEl.blur();
				}
			});
		}

		// Metadata pills (progress, project, due date)
		this.renderMetadataPills(contentEl, card);

		// Tags
		const hideTags = this.getSetting('hide-tags-in-title');
		if (!hideTags && card.tags.length > 0) {
			const tagsEl = contentEl.createDiv({ cls: 'kanban-card-tags' });
			for (const tag of card.tags) {
				const tagEl = tagsEl.createSpan({ cls: 'kanban-card-tag', text: `#${tag}` });
				tagEl.addEventListener('click', (e) => {
					e.stopPropagation();
					// Open search for tag
					(this.app as any).internalPlugins?.plugins?.['global-search']?.instance?.openGlobalSearch(`tag:#${tag}`);
				});
			}
		}

		// Subtasks
		const showSubtasks = this.getSetting('show-subtasks') !== false;
		if (showSubtasks && card.subtasks && card.subtasks.length > 0) {
			this.renderSubtasks(contentEl, card, lane);
		}

		// Notes indicator - show different icons for dedicated notes vs inline notes
		if (card.notePath) {
			const notesIndicator = contentEl.createDiv({ cls: 'kanban-card-notes-indicator has-dedicated-note' });
			setIcon(notesIndicator, 'file-symlink');
			notesIndicator.title = `Open note: ${card.notePath}`;
			notesIndicator.addEventListener('click', (e) => {
				e.stopPropagation();
				this.openCardNote(card);
			});
		} else if (card.notes || card.content) {
			const notesIndicator = contentEl.createDiv({ cls: 'kanban-card-notes-indicator' });
			setIcon(notesIndicator, card.content ? 'file-edit' : 'file-text');
			notesIndicator.title = card.content ? 'Edit card content' : 'Has inline notes';
			notesIndicator.addEventListener('click', (e) => {
				e.stopPropagation();
				this.openCardContentModal(card);
			});
		}

		// Card menu
		const showMenu = this.getSetting('show-card-menu') !== false;
		if (showMenu) {
			const menuBtn = cardEl.createDiv({ cls: 'kanban-card-menu-btn' });
			setIcon(menuBtn, 'more-horizontal');
			menuBtn.addEventListener('click', (event: MouseEvent) => {
				event.stopPropagation();
				this.showCardMenu(event, card, lane);
			});
		}

		// Click to open link or note
		cardEl.addEventListener('click', (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			if (target.contentEditable === 'true' || target.tagName === 'INPUT') return;
			if (target.closest('.kanban-card-menu-btn')) return;
			if (target.closest('.kanban-card-tag')) return;
			if (target.closest('.kanban-card-notes-indicator')) return;
			if (target.closest('.kanban-subtask-checkbox')) return;
			
			// If card has a dedicated note, open it
			if (card.notePath) {
				this.openCardNote(card);
				return;
			}
			
			// Check for wiki link in title
			const linkMatch = card.title.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
			if (linkMatch) {
				this.app.workspace.openLinkText(linkMatch[1], this.file?.path || '');
			}
		});
	}

	private getDisplayTitle(card: KanbanCard): string {
		let title = card.title;

		// Optionally hide tags
		if (this.getSetting('hide-tags-in-title')) {
			title = title.replace(/#[\w-/]+/g, '').trim();
		}

		// Optionally hide dates
		if (this.getSetting('hide-date-in-title')) {
			title = title.replace(/@\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/g, '').trim();
			title = title.replace(/@@\d{2}:\d{2}/g, '').trim();
		}

		// Optionally hide metadata
		if (this.getSetting('hide-metadata-in-title')) {
			title = title.replace(/\[\w+::[^\]]+\]/g, '').trim();
			title = title.replace(/\w+::\S+/g, '').trim();
		}

		return title.replace(/\s+/g, ' ').trim();
	}

	private escapeHtml(text: string): string {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}

	private renderCardTitleHTML(displayTitle: string, card: KanbanCard): string {
		// First escape HTML to prevent XSS
		const escapedTitle = this.escapeHtml(displayTitle);
		
		// Then render wiki links as clickable (after escaping, so [[...]] patterns are preserved)
		// The escape converts [[ to [[ (no change for these chars), so regex still works
		// But we need to escape the link and alias text that goes into href and display
		const html = escapedTitle.replace(
			/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
			(_, link, alias) => {
				// link and alias are already escaped since they came from escapedTitle
				// But we need to properly escape the href attribute value
				const safeHref = link.replace(/"/g, '&quot;');
				return `<a class="internal-link" data-href="${safeHref}">${alias || link}</a>`;
			}
		);
		
		return `<span class="kanban-card-title-text">${html}</span>`;
	}

	private reconstructCardTitle(newText: string, card: KanbanCard): string {
		// When user edits, reconstruct full title with tags/dates/metadata
		let title = newText;

		// Re-add tags if they were hidden
		if (this.getSetting('hide-tags-in-title') && card.tags.length > 0) {
			const existingTags = title.match(/#[\w-/]+/g) || [];
			for (const tag of card.tags) {
				if (!existingTags.includes(`#${tag}`)) {
					title += ` #${tag}`;
				}
			}
		}

		// Re-add date if hidden
		if (this.getSetting('hide-date-in-title') && card.dueDate) {
			if (!title.includes('@')) {
				const dateStr = card.dueTime ? `@${card.dueDate}T${card.dueTime}` : `@${card.dueDate}`;
				title += ` ${dateStr}`;
			}
		}

		return title;
	}

	private renderMetadataPills(container: HTMLElement, card: KanbanCard): void {
		const pillsEl = container.createDiv({ cls: 'kanban-card-metadata-pills' });
		let hasPills = false;

		// Progress pill
		if (this.getSetting('show-progress') && card.metadata.progress !== undefined) {
			hasPills = true;
			const progressPill = pillsEl.createDiv({ cls: 'kanban-metadata-pill kanban-progress-pill' });
			setIcon(progressPill.createSpan(), 'activity');
			const progressValue = progressPill.createSpan({ cls: 'pill-value', text: `${card.metadata.progress}%` });
			
			// Progress bar
			const progressBar = progressPill.createDiv({ cls: 'progress-bar-container' });
			const progressFill = progressBar.createDiv({ cls: 'progress-bar-fill' });
			progressFill.style.width = `${card.metadata.progress}%`;
			
			// Color based on progress
			if (card.metadata.progress >= 100) {
				progressPill.addClass('complete');
			} else if (card.metadata.progress >= 50) {
				progressPill.addClass('in-progress');
			}
		}

		// Project pill
		if (this.getSetting('show-project') && card.metadata.project) {
			hasPills = true;
			const projectPill = pillsEl.createDiv({ cls: 'kanban-metadata-pill kanban-project-pill' });
			setIcon(projectPill.createSpan(), 'folder');
			projectPill.createSpan({ cls: 'pill-value', text: card.metadata.project });
		}

		// Due date/time pill
		if (card.dueDate || card.dueTime) {
			hasPills = true;
			const datePill = pillsEl.createDiv({ cls: 'kanban-metadata-pill kanban-date-pill' });
			setIcon(datePill.createSpan(), card.dueDate ? 'calendar' : 'clock');
			
			let displayText = '';
			
			if (card.dueDate) {
				const showRelative = this.getSetting('show-relative-date');
				const dateFormat = this.getSetting('date-format') || this.plugin.settings['date-format'];
				
				// Use enhanced relative date formatting
				if (showRelative) {
					displayText = formatRelativeDate(card.dueDate);
				} else {
					displayText = formatDate(card.dueDate, dateFormat, false);
				}
				
				// Append time if present
				if (card.dueTime) {
					displayText += ` ${card.dueTime}`;
				}
			} else if (card.dueTime) {
				// Time-only display
				displayText = card.dueTime;
			}
			
			const dateSpan = datePill.createSpan({ cls: 'pill-value', text: displayText });
			
			// Add tooltip with full date
			if (card.dueDate) {
				datePill.title = card.dueDate + (card.dueTime ? `T${card.dueTime}` : '');
			}
			
			// Link to daily note if enabled (only for date, not time-only)
			if (card.dueDate && this.getSetting('link-date-to-daily-note')) {
				dateSpan.addClass('clickable');
				dateSpan.addEventListener('click', (e) => {
					e.stopPropagation();
					this.app.workspace.openLinkText(card.dueDate!, this.file?.path || '');
				});
			}
			
			// Color based on due date (only if date exists)
			if (card.dueDate) {
				const today = new Date().toISOString().split('T')[0];
				if (card.dueDate < today) {
					datePill.addClass('overdue');
				} else if (card.dueDate === today) {
					datePill.addClass('due-today');
				}
			}
		}

		// Recurrence pill
		if (card.recurrence) {
			hasPills = true;
			const recurPill = pillsEl.createDiv({ cls: 'kanban-metadata-pill kanban-recurrence-pill' });
			setIcon(recurPill.createSpan(), 'repeat');
			const recurText = this.formatRecurrenceDisplay(card.recurrence);
			recurPill.createSpan({ cls: 'pill-value', text: recurText });
			
			// Add tooltip with next occurrence
			if (card.dueDate) {
				const nextDate = getNextOccurrence(card.recurrence, new Date(card.dueDate));
				recurPill.title = `Next: ${nextDate.toISOString().split('T')[0]}`;
			}
		}

		// Priority pill
		if (card.metadata.priority) {
			hasPills = true;
			const priorityPill = pillsEl.createDiv({ 
				cls: `kanban-metadata-pill kanban-priority-pill priority-${card.metadata.priority}` 
			});
			setIcon(priorityPill.createSpan(), 'flag');
			priorityPill.createSpan({ cls: 'pill-value', text: card.metadata.priority });
		}

		// Reminder pill
		if (card.reminderTime && this.plugin.settings['enable-reminders']) {
			hasPills = true;
			const reminderPill = pillsEl.createDiv({ cls: 'kanban-metadata-pill kanban-reminder-pill' });
			setIcon(reminderPill.createSpan(), 'bell');
			reminderPill.createSpan({ cls: 'pill-value', text: card.reminderTime });
			reminderPill.title = `Reminder ${card.reminderTime} before due`;
		}

		if (!hasPills) {
			pillsEl.remove();
		}
	}

	private formatRecurrenceDisplay(recurrence: RecurrencePattern): string {
		if (recurrence._rawPattern) {
			// Shorten common patterns for display
			const raw = recurrence._rawPattern.toLowerCase();
			if (raw === 'daily' || raw === 'every day') return 'Daily';
			if (raw === 'weekly' || raw === 'every week') return 'Weekly';
			if (raw === 'monthly' || raw === 'every month') return 'Monthly';
			if (raw === 'yearly' || raw === 'every year' || raw === 'annually') return 'Yearly';
			if (raw === 'weekdays' || raw === 'every weekday') return 'Weekdays';
			if (raw === 'weekends' || raw === 'every weekend') return 'Weekends';
			
			// Return shortened version
			return recurrence._rawPattern.replace(/^every\s+/i, '');
		}
		
		return serializeRecurrence(recurrence);
	}

	private setupCardSortable(cardsEl: HTMLElement, lane: KanbanLane): void {
		const sortable = Sortable.create(cardsEl, {
			group: 'cards',
			animation: 150,
			ghostClass: 'kanban-card-ghost',
			chosenClass: 'kanban-card-chosen',
			dragClass: 'kanban-card-drag',
			handle: '.kanban-card',
			filter: '.kanban-card-menu-btn, input, [contenteditable="true"], .kanban-card-tag, .kanban-metadata-pill',
			preventOnFilter: false,
			onEnd: (event) => {
				const cardId = event.item.getAttribute('data-card-id');
				const fromLaneId = event.from.getAttribute('data-lane-id');
				const toLaneId = event.to.getAttribute('data-lane-id');

				if (!cardId || !fromLaneId || !toLaneId) return;

				const fromLane = this.board.lanes.find(l => l.id === fromLaneId);
				const toLane = this.board.lanes.find(l => l.id === toLaneId);

				if (!fromLane || !toLane) return;

				const cardIndex = fromLane.cards.findIndex(c => c.id === cardId);
				if (cardIndex === -1) return;

				const [card] = fromLane.cards.splice(cardIndex, 1);
				toLane.cards.splice(event.newIndex || 0, 0, card);

				// Notify plugin of card movement for GPT Task Manager integration
				if (fromLaneId !== toLaneId) {
					this.plugin.onCardMovedToLane(card, toLane.title);
				}

				this.requestSave();
				this.render();
			},
		});

		this.sortableInstances.push(sortable);
	}

	private setupLaneSortable(boardEl: HTMLElement): void {
		const sortable = Sortable.create(boardEl, {
			animation: 150,
			ghostClass: 'kanban-lane-ghost',
			chosenClass: 'kanban-lane-chosen',
			dragClass: 'kanban-lane-drag',
			handle: '.kanban-lane-header',
			filter: '.kanban-add-lane-btn, [contenteditable="true"]',
			preventOnFilter: false,
			onEnd: (event) => {
				const oldIndex = event.oldIndex;
				const newIndex = event.newIndex;

				if (oldIndex === undefined || newIndex === undefined) return;
				if (oldIndex === newIndex) return;
				if (newIndex >= this.board.lanes.length) return;

				const [lane] = this.board.lanes.splice(oldIndex, 1);
				this.board.lanes.splice(newIndex, 0, lane);

				this.requestSave();
				this.render();
			},
		});

		this.sortableInstances.push(sortable);
	}

	private showLaneMenu(event: MouseEvent, lane: KanbanLane): void {
		const menu = new Menu();

		menu.addItem((item) => {
			item
				.setTitle('Add card')
				.setIcon('plus')
				.onClick(() => this.addCard(lane));
		});

		// Add from template if configured
		const templatePath = this.getSetting('template-path');
		if (templatePath) {
			menu.addItem((item) => {
				item
					.setTitle('Add card from template')
					.setIcon('file-plus')
					.onClick(() => this.addCardFromTemplate(lane));
			});
		}

		menu.addSeparator();

		menu.addItem((item) => {
			item
				.setTitle('Move left')
				.setIcon('arrow-left')
				.onClick(() => this.moveLane(lane, -1));
		});

		menu.addItem((item) => {
			item
				.setTitle('Move right')
				.setIcon('arrow-right')
				.onClick(() => this.moveLane(lane, 1));
		});

		menu.addSeparator();

		menu.addItem((item) => {
			item
				.setTitle('Archive all cards')
				.setIcon('archive')
				.onClick(() => this.archiveLaneCards(lane));
		});

		menu.addItem((item) => {
			item
				.setTitle('Archive completed')
				.setIcon('check-square')
				.onClick(() => this.archiveCompletedInLane(lane));
		});

		menu.addSeparator();

		// WIP limit configuration
		const wipConfig = this.getLaneWipConfig(lane);
		menu.addItem((item) => {
			item
				.setTitle(`Set WIP limit${wipConfig.limit > 0 ? ` (currently ${wipConfig.limit})` : ''}`)
				.setIcon('gauge')
				.onClick(() => this.showWipLimitModal(lane));
		});

		menu.addSeparator();

		menu.addItem((item) => {
			item
				.setTitle('Delete list')
				.setIcon('trash')
				.onClick(() => this.deleteLane(lane));
		});

		menu.showAtMouseEvent(event);
	}

	private showWipLimitModal(lane: KanbanLane): void {
		const modal = new WipLimitModal(this.app, lane, this.getLaneWipConfig(lane), (config) => {
			// Save the lane-specific WIP config
			if (!this.board.settings['lane-configs']) {
				this.board.settings['lane-configs'] = {};
			}
			
			if (!this.board.settings['lane-configs'][lane.title]) {
				this.board.settings['lane-configs'][lane.title] = {};
			}
			
			this.board.settings['lane-configs'][lane.title].wipLimit = config;
			this.requestSave();
			this.render();
		});
		modal.open();
	}

	private showCardMenu(event: MouseEvent, card: KanbanCard, lane: KanbanLane): void {
		const menu = new Menu();

		menu.addItem((item) => {
			item
				.setTitle('Edit card')
				.setIcon('pencil')
				.onClick(() => this.openCardEditModal(card));
		});

		// Dedicated note actions
		if (card.notePath) {
			menu.addItem((item) => {
				item
					.setTitle('Open note')
					.setIcon('file-symlink')
					.onClick(() => this.openCardNote(card));
			});
			menu.addItem((item) => {
				item
					.setTitle('Sync to note')
					.setIcon('refresh-cw')
					.onClick(() => this.syncCardToNote(card));
			});
			menu.addItem((item) => {
				item
					.setTitle('Unlink note')
					.setIcon('unlink')
					.onClick(() => this.unlinkCardNote(card));
			});
		} else {
			menu.addItem((item) => {
				item
					.setTitle('Create note')
					.setIcon('file-plus')
					.onClick(() => this.createCardNote(card));
			});
			menu.addItem((item) => {
				item
					.setTitle('Link to existing note')
					.setIcon('link')
					.onClick(() => this.linkToExistingNote(card));
			});
		}

		// Edit content (subtasks, notes, etc.)
		menu.addItem((item) => {
			item
				.setTitle('Edit content')
				.setIcon('file-edit')
				.onClick(() => this.openCardContentModal(card));
		});

		// Inline notes (only if no dedicated note)
		if (!card.notePath && !card.content) {
			menu.addItem((item) => {
				item
					.setTitle('Edit inline notes')
					.setIcon('file-text')
					.onClick(() => this.openCardNotesModal(card));
			});
		}

		menu.addSeparator();

		// Move to other lanes
		const otherLanes = this.board.lanes.filter(l => l.id !== lane.id);
		if (otherLanes.length > 0) {
			menu.addItem((item) => {
				item.setTitle('Move to...');
				item.setIcon('arrow-right');
				
				const submenu = (item as any).setSubmenu();
				for (const targetLane of otherLanes) {
					submenu.addItem((subItem: any) => {
						subItem
							.setTitle(targetLane.title)
							.onClick(() => this.moveCard(card, lane, targetLane));
					});
				}
			});
		}

		menu.addSeparator();

		// Metadata quick actions
		menu.addItem((item) => {
			item
				.setTitle('Set progress...')
				.setIcon('activity')
				.onClick(() => this.setCardProgress(card));
		});

		menu.addItem((item) => {
			item
				.setTitle('Set project...')
				.setIcon('folder')
				.onClick(() => this.setCardProject(card));
		});

		menu.addItem((item) => {
			item
				.setTitle('Set due date...')
				.setIcon('calendar')
				.onClick(() => this.setCardDueDate(card));
		});

		menu.addSeparator();

		// Base sync options
		const syncConfig = this.getBaseSyncConfig();
		if (syncConfig.enabled) {
			if (card.baseTaskPath) {
				menu.addItem((item) => {
					item
						.setTitle('Open Base task')
						.setIcon('external-link')
						.onClick(() => {
							if (card.baseTaskPath) {
								this.app.workspace.openLinkText(card.baseTaskPath, '');
							}
						});
				});
				menu.addItem((item) => {
					item
						.setTitle('Unlink from Base')
						.setIcon('unlink')
						.onClick(() => {
							card.baseTaskPath = undefined;
							card.baseSyncTime = undefined;
							this.requestSave();
							this.render();
							new Notice('Card unlinked from Base task');
						});
				});
			} else {
				menu.addItem((item) => {
					item
						.setTitle('Link to Base task')
						.setIcon('link')
						.onClick(() => this.linkCardToBaseTask(card));
				});
				menu.addItem((item) => {
					item
						.setTitle('Create Base task')
						.setIcon('file-plus-2')
						.onClick(() => this.createBaseTaskForCard(card, lane));
				});
			}
			menu.addSeparator();
		}

		menu.addItem((item) => {
			item
				.setTitle('Archive')
				.setIcon('archive')
				.onClick(() => this.archiveCard(card, lane));
		});

		menu.addItem((item) => {
			item
				.setTitle('Delete')
				.setIcon('trash')
				.onClick(() => this.deleteCard(card, lane));
		});

		menu.showAtMouseEvent(event);
	}

	// Lane operations
	addLane(): void {
		const newLane: KanbanLane = {
			id: Math.random().toString(36).substring(2, 11) + Date.now().toString(36).slice(-4),
			title: 'New List',
			cards: [],
		};

		this.board.lanes.push(newLane);
		this.requestSave();
		this.render();

		// Focus the new lane title
		setTimeout(() => {
			const laneEl = this.boardContainer.querySelector(`[data-lane-id="${newLane.id}"] .kanban-lane-title`);
			if (laneEl instanceof HTMLElement) {
				laneEl.focus();
				const range = document.createRange();
				range.selectNodeContents(laneEl);
				const selection = window.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);
			}
		}, 50);
	}

	private moveLane(lane: KanbanLane, direction: number): void {
		const index = this.board.lanes.indexOf(lane);
		const newIndex = index + direction;

		if (newIndex < 0 || newIndex >= this.board.lanes.length) return;

		this.board.lanes.splice(index, 1);
		this.board.lanes.splice(newIndex, 0, lane);

		this.requestSave();
		this.render();
	}

	private deleteLane(lane: KanbanLane): void {
		const index = this.board.lanes.indexOf(lane);
		if (index === -1) return;

		this.board.lanes.splice(index, 1);
		this.requestSave();
		this.render();
	}

	// Card operations
	addCard(lane: KanbanLane): void {
		const defaultProject = this.getSetting('default-project');
		
		const newCard: KanbanCard = {
			id: Math.random().toString(36).substring(2, 11) + Date.now().toString(36).slice(-4),
			title: 'New card',
			completed: false,
			tags: [],
			metadata: defaultProject ? { project: defaultProject } : {},
		};

		const insertMethod = this.getSetting('new-card-insertion-method') || this.plugin.settings['new-card-insertion-method'];
		if (insertMethod === 'prepend') {
			lane.cards.unshift(newCard);
		} else {
			lane.cards.push(newCard);
		}

		this.requestSave();
		this.render();

		// Focus the new card title
		setTimeout(() => {
			const cardEl = this.boardContainer.querySelector(`[data-card-id="${newCard.id}"] .kanban-card-title-text`);
			if (cardEl instanceof HTMLElement) {
				cardEl.focus();
				const range = document.createRange();
				range.selectNodeContents(cardEl);
				const selection = window.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);
			}
		}, 50);

		// Auto-create note if enabled
		const autoCreateNote = this.getSetting('auto-create-note') || this.plugin.settings['auto-create-note'];
		if (autoCreateNote) {
			// Defer note creation to allow card title to be edited first
			// The note will be created when the card title is set (on blur)
			this.pendingAutoCreateNote = { card: newCard, lane };
		}
	}

	// Pending auto-create note tracking
	private pendingAutoCreateNote: { card: KanbanCard; lane: KanbanLane } | null = null;

	private async addCardFromTemplate(lane: KanbanLane): Promise<void> {
		const templatePath = this.getSetting('template-path');
		if (!templatePath) return;

		const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
		if (!(templateFile instanceof TFile)) {
			console.warn('Template file not found:', templatePath);
			return;
		}

		try {
			const content = await this.app.vault.read(templateFile);
			const defaultProject = this.getSetting('default-project');
			const newCard = createCardFromTemplate(content, defaultProject ? { project: defaultProject } : {});

			const insertMethod = this.getSetting('new-card-insertion-method') || this.plugin.settings['new-card-insertion-method'];
			if (insertMethod === 'prepend') {
				lane.cards.unshift(newCard);
			} else {
				lane.cards.push(newCard);
			}

			this.requestSave();
			this.render();
		} catch (error) {
			console.error('Error reading template:', error);
		}
	}

	private moveCard(card: KanbanCard, fromLane: KanbanLane, toLane: KanbanLane): void {
		const cardIndex = fromLane.cards.indexOf(card);
		if (cardIndex === -1) return;

		fromLane.cards.splice(cardIndex, 1);
		toLane.cards.push(card);

		// Sync status to Base if enabled
		this.syncCardStatusToBase(card, toLane);

		this.requestSave();
		this.render();
	}

	private async syncCardStatusToBase(card: KanbanCard, lane: KanbanLane): Promise<void> {
		const syncConfig = this.getBaseSyncConfig();
		if (!syncConfig.enabled) return;

		this.baseSyncService.setConfig(syncConfig);
		
		if (card.baseTaskPath) {
			const success = await this.baseSyncService.onCardMoveToLane(card, lane);
			if (success) {
				updateSyncStatus(this.syncStatusEl, 'success', 'Status synced');
			}
		} else if (syncConfig.createMissingTasks) {
			// Create a new Base task for this card
			const taskPath = await this.baseSyncService.createBaseTask(card.title, card.metadata, lane);
			if (taskPath) {
				card.baseTaskPath = taskPath;
				card.baseSyncTime = Date.now();
				updateSyncStatus(this.syncStatusEl, 'success', 'Task created');
			}
		}
	}

	private deleteCard(card: KanbanCard, lane: KanbanLane): void {
		const index = lane.cards.indexOf(card);
		if (index === -1) return;

		lane.cards.splice(index, 1);
		this.requestSave();
		this.render();
	}

	private archiveCard(card: KanbanCard, lane: KanbanLane): void {
		const index = lane.cards.indexOf(card);
		if (index === -1) return;

		lane.cards.splice(index, 1);
		
		// Optionally prepend archive date
		let archivedCard = card;
		if (this.plugin.settings['prepend-archive-date']) {
			archivedCard = prependArchiveDate(card, this.plugin.settings['prepend-archive-format']);
		}
		
		this.board.archive.push(archivedCard);
		this.requestSave();
		this.render();
	}

	private archiveLaneCards(lane: KanbanLane): void {
		for (const card of lane.cards) {
			let archivedCard = card;
			if (this.plugin.settings['prepend-archive-date']) {
				archivedCard = prependArchiveDate(card, this.plugin.settings['prepend-archive-format']);
			}
			this.board.archive.push(archivedCard);
		}
		lane.cards = [];
		this.requestSave();
		this.render();
	}

	private archiveCompletedInLane(lane: KanbanLane): void {
		const completed = lane.cards.filter(card => card.completed);
		const remaining = lane.cards.filter(card => !card.completed);

		for (const card of completed) {
			let archivedCard = card;
			if (this.plugin.settings['prepend-archive-date']) {
				archivedCard = prependArchiveDate(card, this.plugin.settings['prepend-archive-format']);
			}
			this.board.archive.push(archivedCard);
		}

		lane.cards = remaining;
		this.requestSave();
		this.render();
	}

	archiveCompletedCards(): void {
		for (const lane of this.board.lanes) {
			const completedCards = lane.cards.filter(card => card.completed);
			const remainingCards = lane.cards.filter(card => !card.completed);
			
			for (const card of completedCards) {
				let archivedCard = card;
				if (this.plugin.settings['prepend-archive-date']) {
					archivedCard = prependArchiveDate(card, this.plugin.settings['prepend-archive-format']);
				}
				this.board.archive.push(archivedCard);
			}
			
			lane.cards = remainingCards;
		}

		this.requestSave();
		this.render();
	}

	// Modal dialogs
	private openCardEditModal(card: KanbanCard): void {
		const modal = new CardEditModal(this.app, card, (updatedCard) => {
			Object.assign(card, updatedCard);
			this.requestSave();
			this.render();
		});
		modal.open();
	}

	private openCardNotesModal(card: KanbanCard): void {
		const modal = new CardNotesModal(this.app, card, (notes) => {
			card.notes = notes || undefined;
			this.requestSave();
			this.render();
		});
		modal.open();
	}

	private openCardContentModal(card: KanbanCard): void {
		const modal = new CardContentModal(this.app, card, (content, subtasks) => {
			card.content = content || undefined;
			card.subtasks = subtasks && subtasks.length > 0 ? subtasks : undefined;
			// If we have notes content from old format, preserve it
			if (!content && card.notes) {
				// Keep notes as-is
			} else if (content) {
				// Parse notes from content (> lines)
				const noteLines: string[] = [];
				for (const line of content.split('\n')) {
					const noteMatch = line.match(/^\s*>\s?(.*)$/);
					if (noteMatch) {
						noteLines.push(noteMatch[1]);
					}
				}
				card.notes = noteLines.length > 0 ? noteLines.join('\n') : undefined;
			}
			this.requestSave();
			this.render();
		});
		modal.open();
	}

	private setCardProgress(card: KanbanCard): void {
		const modal = new QuickInputModal(this.app, 'Set Progress', 'Enter progress (0-100%)', 
			card.metadata.progress?.toString() || '0',
			async (value) => {
				const progress = parseInt(value.replace('%', ''), 10);
				if (!isNaN(progress)) {
					const newProgress = Math.min(100, Math.max(0, progress));
					card.metadata.progress = newProgress;
					
					// Sync to Base
					await this.syncCardProgressToBase(card, newProgress);
					
					this.requestSave();
					this.render();
				}
			}
		);
		modal.open();
	}

	private async syncCardProgressToBase(card: KanbanCard, progress: number): Promise<void> {
		const syncConfig = this.getBaseSyncConfig();
		if (!syncConfig.enabled || !card.baseTaskPath) return;

		this.baseSyncService.setConfig(syncConfig);
		const success = await this.baseSyncService.syncProgress(card, progress);
		if (success) {
			updateSyncStatus(this.syncStatusEl, 'success', 'Progress synced');
		}
	}

	private setCardProject(card: KanbanCard): void {
		const modal = new QuickInputModal(this.app, 'Set Project', 'Enter project name',
			card.metadata.project || '',
			async (value) => {
				card.metadata.project = value || undefined;
				
				// Sync to Base
				await this.syncCardProjectToBase(card, value);
				
				this.requestSave();
				this.render();
			}
		);
		modal.open();
	}

	private async syncCardProjectToBase(card: KanbanCard, project: string | undefined): Promise<void> {
		const syncConfig = this.getBaseSyncConfig();
		if (!syncConfig.enabled || !card.baseTaskPath) return;

		this.baseSyncService.setConfig(syncConfig);
		const success = await this.baseSyncService.syncProject(card, project);
		if (success) {
			updateSyncStatus(this.syncStatusEl, 'success', 'Project synced');
		}
	}

	private setCardDueDate(card: KanbanCard): void {
		const modal = new QuickInputModal(this.app, 'Set Due Date', 'Enter date (YYYY-MM-DD)',
			card.dueDate || '',
			(value) => {
				if (value.match(/^\d{4}-\d{2}-\d{2}$/)) {
					card.dueDate = value;
				} else if (!value) {
					card.dueDate = undefined;
				}
				this.requestSave();
				this.render();
			}
		);
		modal.open();
	}

	private openBoardSettings(): void {
		const modal = new BoardSettingsModal(this.app, this.board.settings, (settings) => {
			this.board.settings = settings;
			this.requestSave();
			this.render();
		});
		modal.open();
	}

	// Card note operations
	async openCardNote(card: KanbanCard): Promise<void> {
		if (!card.notePath) return;
		
		const file = this.app.vault.getAbstractFileByPath(card.notePath);
		if (file instanceof TFile) {
			// Sync card metadata from note before opening
			await this.syncCardFromNote(card, file);
			await this.app.workspace.openLinkText(card.notePath, this.file?.path || '');
		} else {
			// Note file doesn't exist anymore, offer to recreate
			const modal = new ConfirmModal(
				this.app,
				'Note not found',
				`The note "${card.notePath}" no longer exists. Would you like to create it?`,
				async () => {
					await this.createCardNote(card);
				}
			);
			modal.open();
		}
	}

	async createCardNote(card: KanbanCard): Promise<void> {
		// Get template and folder settings
		const templatePath = this.getSetting('card-note-template') || this.plugin.settings['card-note-template'];
		const noteFolder = this.getSetting('card-note-folder') || this.plugin.settings['card-note-folder'];
		
		// Generate note filename from card title (sanitize for filesystem)
		const sanitizedTitle = this.sanitizeFilename(card.title);
		const baseName = sanitizedTitle || `card-${card.id}`;
		
		// Determine target folder
		let targetPath = '';
		if (noteFolder) {
			// Ensure folder exists
			const folder = this.app.vault.getAbstractFileByPath(noteFolder);
			if (!folder) {
				await this.app.vault.createFolder(noteFolder);
			}
			targetPath = `${noteFolder}/${baseName}.md`;
		} else {
			// Use same folder as kanban board
			const boardFolder = this.file?.parent?.path || '';
			targetPath = boardFolder ? `${boardFolder}/${baseName}.md` : `${baseName}.md`;
		}
		
		// Ensure unique filename
		targetPath = await this.ensureUniqueFilename(targetPath);
		
		// Generate note content
		let content = await this.generateCardNoteContent(card, templatePath);
		
		try {
			// Create the note
			const newFile = await this.app.vault.create(targetPath, content);
			
			// Update card with note path
			card.notePath = newFile.path;
			
			// Clear inline notes since we're moving to dedicated note
			if (card.notes) {
				// Optionally append inline notes to the new note
				const existingContent = await this.app.vault.read(newFile);
				if (!existingContent.includes(card.notes)) {
					await this.app.vault.modify(newFile, existingContent + '\n\n## Notes\n\n' + card.notes);
				}
				card.notes = undefined;
			}
			
			this.requestSave();
			this.render();
			
			// Open the newly created note
			await this.app.workspace.openLinkText(newFile.path, this.file?.path || '');
		} catch (error) {
			console.error('Error creating card note:', error);
		}
	}

	/**
	 * Unlink a dedicated note from a card (keeps the note file, just removes the link)
	 */
	async unlinkCardNote(card: KanbanCard): Promise<void> {
		if (!card.notePath) return;
		
		const modal = new ConfirmModal(
			this.app,
			'Unlink note',
			`Unlink "${card.notePath}" from this card? The note file will be kept.`,
			() => {
				card.notePath = undefined;
				this.requestSave();
				this.render();
				new Notice('Note unlinked from card');
			}
		);
		modal.open();
	}

	/**
	 * Link a card to an existing note file
	 */
	async linkToExistingNote(card: KanbanCard): Promise<void> {
		const modal = new NoteLinkModal(this.app, async (notePath) => {
			if (notePath) {
				card.notePath = notePath;
				
				// Sync metadata from the note
				const file = this.app.vault.getAbstractFileByPath(notePath);
				if (file instanceof TFile) {
					await this.syncCardFromNote(card, file);
				}
				
				this.requestSave();
				this.render();
				new Notice(`Card linked to: ${notePath}`);
			}
		});
		modal.open();
	}

	private sanitizeFilename(title: string): string {
		// Remove wiki link syntax
		let name = title.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1');
		// Remove metadata
		name = name.replace(/\[\w+::[^\]]+\]/g, '');
		name = name.replace(/\w+::\S+/g, '');
		// Remove tags
		name = name.replace(/#[\w-/]+/g, '');
		// Remove dates
		name = name.replace(/@\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/g, '');
		name = name.replace(/@@\d{2}:\d{2}/g, '');
		// Remove invalid filename characters
		name = name.replace(/[\\/:*?"<>|]/g, '');
		// Collapse whitespace
		name = name.replace(/\s+/g, ' ').trim();
		// Limit length
		if (name.length > 100) {
			name = name.substring(0, 100).trim();
		}
		return name;
	}

	private async ensureUniqueFilename(path: string): Promise<string> {
		const ext = path.endsWith('.md') ? '' : '.md';
		let targetPath = path.endsWith('.md') ? path : path + ext;
		let counter = 1;
		
		while (this.app.vault.getAbstractFileByPath(targetPath)) {
			const basePath = path.replace(/\.md$/, '');
			targetPath = `${basePath} ${counter}.md`;
			counter++;
		}
		
		return targetPath;
	}

	private async generateCardNoteContent(card: KanbanCard, templatePath?: string): Promise<string> {
		let content = '';
		
		// Try to use template
		if (templatePath) {
			const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
			if (templateFile instanceof TFile) {
				try {
					content = await this.app.vault.read(templateFile);
					// Replace template variables
					content = this.processCardNoteTemplate(content, card);
				} catch (error) {
					console.warn('Error reading template:', error);
				}
			}
		}
		
		// Generate default content if no template or template failed
		if (!content) {
			content = this.generateDefaultCardNoteContent(card);
		}
		
		return content;
	}

	private processCardNoteTemplate(template: string, card: KanbanCard): string {
		// Create template context with card data
		const context = createTemplateContext({
			title: card.title,
			project: card.metadata.project,
			dueDate: card.dueDate,
			priority: card.metadata.priority,
			tags: card.tags,
			customVars: {
				dueTime: card.dueTime || '',
				progress: card.metadata.progress?.toString() || '',
				completed: card.completed ? 'true' : 'false',
				board: this.file?.basename || '',
				boardPath: this.file?.path || '',
				cardId: card.id,
				notes: card.notes || '',
			},
		});
		
		// Use the new template system
		return substituteTemplateVariables(template, context);
	}

	private generateDefaultCardNoteContent(card: KanbanCard): string {
		const lines: string[] = [];
		
		// Generate frontmatter with comprehensive metadata
		lines.push('---');
		lines.push(`kanban-card: ${card.id}`);
		lines.push(`kanban-board: "[[${this.file?.basename || 'Kanban'}]]"`);
		if (card.dueDate) {
			lines.push(`due: ${card.dueDate}${card.dueTime ? 'T' + card.dueTime : ''}`);
		}
		if (card.metadata.progress !== undefined) {
			lines.push(`progress: ${card.metadata.progress}`);
		}
		if (card.metadata.project) {
			lines.push(`project: "${card.metadata.project}"`);
		}
		if (card.metadata.priority) {
			lines.push(`priority: ${card.metadata.priority}`);
		}
		if (card.tags.length > 0) {
			lines.push(`tags: [${card.tags.map(t => `"${t}"`).join(', ')}]`);
		}
		lines.push(`completed: ${card.completed}`);
		lines.push(`created: ${new Date().toISOString().split('T')[0]}`);
		lines.push('---');
		lines.push('');
		
		// Title as heading (use display title, cleaned)
		const cleanTitle = this.getDisplayTitle(card);
		lines.push(`# ${cleanTitle || 'Card'}`);
		lines.push('');
		
		// Add existing notes if any
		if (card.notes) {
			lines.push('## Notes');
			lines.push('');
			lines.push(card.notes);
			lines.push('');
		}
		
		// Add subtasks if any
		if (card.subtasks && card.subtasks.length > 0) {
			lines.push('## Tasks');
			lines.push('');
			for (const subtask of card.subtasks) {
				lines.push(`- [${subtask.completed ? 'x' : ' '}] ${subtask.text}`);
			}
			lines.push('');
		}
		
		return lines.join('\n');
	}

	/**
	 * Sync card metadata TO the note's frontmatter
	 */
	async syncCardToNote(card: KanbanCard): Promise<void> {
		if (!card.notePath) return;
		
		const file = this.app.vault.getAbstractFileByPath(card.notePath);
		if (!(file instanceof TFile)) return;
		
		try {
			let content = await this.app.vault.read(file);
			
			// Parse existing frontmatter
			const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
			
			if (fmMatch) {
				// Update existing frontmatter
				let frontmatter = fmMatch[1];
				
				// Update or add fields
				frontmatter = this.updateFrontmatterField(frontmatter, 'due', 
					card.dueDate ? (card.dueTime ? `${card.dueDate}T${card.dueTime}` : card.dueDate) : undefined);
				frontmatter = this.updateFrontmatterField(frontmatter, 'progress', 
					card.metadata.progress !== undefined ? String(card.metadata.progress) : undefined);
				frontmatter = this.updateFrontmatterField(frontmatter, 'project', card.metadata.project);
				frontmatter = this.updateFrontmatterField(frontmatter, 'priority', card.metadata.priority);
				frontmatter = this.updateFrontmatterField(frontmatter, 'completed', String(card.completed));
				
				if (card.tags.length > 0) {
					frontmatter = this.updateFrontmatterField(frontmatter, 'tags', 
						`[${card.tags.map(t => `"${t}"`).join(', ')}]`);
				}
				
				content = content.replace(fmMatch[0], `---\n${frontmatter}\n---`);
			} else {
				// Add new frontmatter
				const newFrontmatter = this.generateCardFrontmatter(card);
				content = newFrontmatter + '\n' + content;
			}
			
			// Update the first H1 heading if it exists
			const headingMatch = content.match(/^# .+$/m);
			if (headingMatch) {
				const cleanTitle = this.getDisplayTitle(card);
				content = content.replace(headingMatch[0], `# ${cleanTitle}`);
			}
			
			await this.app.vault.modify(file, content);
		} catch (error) {
			console.warn('Error syncing card to note:', error);
		}
	}

	private updateFrontmatterField(frontmatter: string, field: string, value: string | undefined): string {
		const lines = frontmatter.split('\n');
		const fieldRegex = new RegExp(`^${field}:\\s*.*$`, 'm');
		
		if (value !== undefined && value !== '') {
			// Check if field exists
			const existingIndex = lines.findIndex(line => line.startsWith(`${field}:`));
			const needsQuotes = value.includes(':') || value.includes('#') || value.includes('"');
			const formattedValue = needsQuotes && !value.startsWith('[') ? `"${value}"` : value;
			
			if (existingIndex >= 0) {
				lines[existingIndex] = `${field}: ${formattedValue}`;
			} else {
				// Add before the last line (which might be empty)
				lines.push(`${field}: ${formattedValue}`);
			}
		} else {
			// Remove field if value is empty
			const existingIndex = lines.findIndex(line => line.startsWith(`${field}:`));
			if (existingIndex >= 0) {
				lines.splice(existingIndex, 1);
			}
		}
		
		return lines.filter(line => line.trim() !== '' || line === '').join('\n');
	}

	private generateCardFrontmatter(card: KanbanCard): string {
		const lines: string[] = ['---'];
		lines.push(`kanban-card: ${card.id}`);
		lines.push(`kanban-board: "[[${this.file?.basename || 'Kanban'}]]"`);
		if (card.dueDate) {
			lines.push(`due: ${card.dueDate}${card.dueTime ? 'T' + card.dueTime : ''}`);
		}
		if (card.metadata.progress !== undefined) {
			lines.push(`progress: ${card.metadata.progress}`);
		}
		if (card.metadata.project) {
			lines.push(`project: "${card.metadata.project}"`);
		}
		if (card.metadata.priority) {
			lines.push(`priority: ${card.metadata.priority}`);
		}
		if (card.tags.length > 0) {
			lines.push(`tags: [${card.tags.map(t => `"${t}"`).join(', ')}]`);
		}
		lines.push(`completed: ${card.completed}`);
		lines.push('---');
		return lines.join('\n');
	}

	async syncCardFromNote(card: KanbanCard, file: TFile): Promise<void> {
		try {
			const content = await this.app.vault.read(file);
			const cache = this.app.metadataCache.getFileCache(file);
			
			if (cache?.frontmatter) {
				const fm = cache.frontmatter;
				
				// Sync title from first heading or filename
				if (cache.headings && cache.headings.length > 0) {
					const firstHeading = cache.headings[0];
					if (firstHeading.level === 1) {
						// Extract clean title from heading
						const newTitle = firstHeading.heading;
						if (newTitle && newTitle !== card.title) {
							card.title = newTitle;
						}
					}
				}
				
				// Sync metadata from frontmatter
				if (fm.due && typeof fm.due === 'string') {
					card.dueDate = fm.due;
				}
				if (fm.progress !== undefined) {
					card.metadata.progress = typeof fm.progress === 'number' ? fm.progress : parseInt(fm.progress, 10);
				}
				if (fm.project) {
					card.metadata.project = fm.project;
				}
				if (fm.priority) {
					card.metadata.priority = fm.priority;
				}
				if (fm.completed !== undefined) {
					card.completed = fm.completed === true || fm.completed === 'true';
				}
				if (Array.isArray(fm.tags)) {
					card.tags = fm.tags.map((t: string) => t.replace(/^#/, ''));
				}
				
				this.requestSave();
				this.render();
			}
		} catch (error) {
			console.warn('Error syncing card from note:', error);
		}
	}

	// Public method for command palette
	async createOrOpenCardNote(): Promise<void> {
		// Find focused card or show selection modal
		const focusedCard = this.findFocusedCard();
		if (focusedCard) {
			if (focusedCard.card.notePath) {
				await this.openCardNote(focusedCard.card);
			} else {
				await this.createCardNote(focusedCard.card);
			}
		}
	}

	private findFocusedCard(): { card: KanbanCard; lane: KanbanLane } | null {
		// Try to find a card that's currently focused or has a selection
		const activeElement = document.activeElement;
		if (activeElement) {
			const cardEl = activeElement.closest('[data-card-id]');
			if (cardEl) {
				const cardId = cardEl.getAttribute('data-card-id');
				for (const lane of this.board.lanes) {
					const card = lane.cards.find(c => c.id === cardId);
					if (card) {
						return { card, lane };
					}
				}
			}
		}
		return null;
	}
}

// Card Edit Modal
class CardEditModal extends Modal {
	card: KanbanCard;
	onSave: (card: KanbanCard) => void;

	constructor(app: any, card: KanbanCard, onSave: (card: KanbanCard) => void) {
		super(app);
		this.card = { ...card, metadata: { ...card.metadata } };
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('kanban-card-edit-modal');

		contentEl.createEl('h2', { text: 'Edit Card' });

		new Setting(contentEl)
			.setName('Title')
			.addText(text => text
				.setValue(this.card.title)
				.onChange(value => this.card.title = value));

		new Setting(contentEl)
			.setName('Due Date')
			.setDesc('YYYY-MM-DD format')
			.addText(text => text
				.setValue(this.card.dueDate || '')
				.onChange(value => this.card.dueDate = value || undefined));

		new Setting(contentEl)
			.setName('Progress')
			.setDesc('0-100')
			.addSlider(slider => slider
				.setLimits(0, 100, 5)
				.setValue(this.card.metadata.progress || 0)
				.setDynamicTooltip()
				.onChange(value => this.card.metadata.progress = value));

		new Setting(contentEl)
			.setName('Project')
			.addText(text => text
				.setValue(this.card.metadata.project || '')
				.onChange(value => this.card.metadata.project = value || undefined));

		new Setting(contentEl)
			.setName('Priority')
			.addDropdown(dropdown => dropdown
				.addOption('', 'None')
				.addOption('low', 'Low')
				.addOption('medium', 'Medium')
				.addOption('high', 'High')
				.addOption('urgent', 'Urgent')
				.setValue(this.card.metadata.priority || '')
				.onChange(value => this.card.metadata.priority = value as any || undefined));

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Save')
				.setCta()
				.onClick(() => {
					this.onSave(this.card);
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// Card Notes Modal
class CardNotesModal extends Modal {
	card: KanbanCard;
	onSave: (notes: string) => void;
	notesValue: string;

	constructor(app: any, card: KanbanCard, onSave: (notes: string) => void) {
		super(app);
		this.card = card;
		this.notesValue = card.notes || '';
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('kanban-card-notes-modal');

		contentEl.createEl('h2', { text: 'Card Notes' });
		contentEl.createEl('p', { text: this.card.title, cls: 'kanban-notes-card-title' });

		const textarea = contentEl.createEl('textarea', {
			cls: 'kanban-notes-textarea',
			attr: { rows: '10' }
		});
		textarea.value = this.notesValue;
		textarea.addEventListener('input', () => {
			this.notesValue = textarea.value;
		});

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Save')
				.setCta()
				.onClick(() => {
					this.onSave(this.notesValue);
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// Card Content Modal - For editing multi-line content and subtasks
class CardContentModal extends Modal {
	card: KanbanCard;
	onSave: (content: string, subtasks: Subtask[]) => void;
	contentValue: string;
	subtasks: Subtask[];

	constructor(app: any, card: KanbanCard, onSave: (content: string, subtasks: Subtask[]) => void) {
		super(app);
		this.card = card;
		this.contentValue = card.content || '';
		this.subtasks = card.subtasks ? [...card.subtasks] : [];
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('kanban-card-content-modal');

		contentEl.createEl('h2', { text: 'Edit Card Content' });
		contentEl.createEl('p', { text: this.card.title, cls: 'kanban-content-card-title' });

		// Info text
		contentEl.createEl('p', { 
			text: 'Add subtasks with "- [ ] task" format. Content is saved in markdown under the card.',
			cls: 'kanban-content-info'
		});

		// Content textarea
		const textarea = contentEl.createEl('textarea', {
			cls: 'kanban-content-textarea',
			attr: { rows: '12', placeholder: 'Add content, notes, or subtasks...\n\n- [ ] Subtask 1\n- [ ] Subtask 2\n\n> Notes can use > prefix' }
		});
		
		// If we have subtasks but no content, generate content from subtasks
		if (this.subtasks.length > 0 && !this.contentValue) {
			const subtaskLines = this.subtasks.map(s => `\t- [${s.completed ? 'x' : ' '}] ${s.text}`);
			this.contentValue = subtaskLines.join('\n');
		}
		
		// If we have notes but no content, add notes to content
		if (this.card.notes && !this.contentValue) {
			const noteLines = this.card.notes.split('\n').map(line => `\t> ${line}`);
			this.contentValue = noteLines.join('\n');
		}
		
		textarea.value = this.contentValue;
		
		textarea.addEventListener('input', () => {
			this.contentValue = textarea.value;
			this.parseSubtasksFromContent();
			this.updateSubtaskPreview();
		});

		// Subtask preview
		const previewEl = contentEl.createDiv({ cls: 'kanban-content-preview' });
		previewEl.createEl('h4', { text: 'Subtasks Preview' });
		this.subtaskPreviewEl = previewEl.createDiv({ cls: 'kanban-subtask-preview-list' });
		this.updateSubtaskPreview();

		// Add subtask quick button
		const quickAddEl = contentEl.createDiv({ cls: 'kanban-quick-add-subtask' });
		const subtaskInput = quickAddEl.createEl('input', {
			type: 'text',
			cls: 'kanban-subtask-input',
			attr: { placeholder: 'Quick add subtask...' }
		});
		const addBtn = quickAddEl.createEl('button', { text: 'Add' });
		
		const addSubtask = () => {
			const text = subtaskInput.value.trim();
			if (text) {
				// Add to content
				const newSubtask = `\t- [ ] ${text}`;
				if (this.contentValue) {
					this.contentValue += '\n' + newSubtask;
				} else {
					this.contentValue = newSubtask;
				}
				textarea.value = this.contentValue;
				this.parseSubtasksFromContent();
				this.updateSubtaskPreview();
				subtaskInput.value = '';
			}
		};
		
		addBtn.addEventListener('click', addSubtask);
		subtaskInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				addSubtask();
			}
		});

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Save')
				.setCta()
				.onClick(() => {
					this.parseSubtasksFromContent();
					this.onSave(this.contentValue, this.subtasks);
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));
	}

	subtaskPreviewEl: HTMLElement;

	private parseSubtasksFromContent(): void {
		this.subtasks = [];
		const lines = this.contentValue.split('\n');
		
		for (const line of lines) {
			const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
			if (match) {
				this.subtasks.push({
					id: Math.random().toString(36).substring(2, 11) + Date.now().toString(36).slice(-4),
					text: match[2].trim(),
					completed: match[1].toLowerCase() === 'x',
				});
			}
		}
	}

	private updateSubtaskPreview(): void {
		this.subtaskPreviewEl.empty();
		
		if (this.subtasks.length === 0) {
			this.subtaskPreviewEl.createEl('p', { 
				text: 'No subtasks found. Add subtasks with "- [ ] task" format.',
				cls: 'kanban-subtask-empty'
			});
			return;
		}

		const completed = this.subtasks.filter(s => s.completed).length;
		this.subtaskPreviewEl.createEl('p', { 
			text: `${completed}/${this.subtasks.length} completed`,
			cls: 'kanban-subtask-summary'
		});

		for (const subtask of this.subtasks) {
			const subtaskEl = this.subtaskPreviewEl.createDiv({ 
				cls: `kanban-subtask-preview-item ${subtask.completed ? 'is-completed' : ''}` 
			});
			subtaskEl.createSpan({ text: subtask.completed ? '☑' : '☐' });
			subtaskEl.createSpan({ text: subtask.text });
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// Quick Input Modal
class QuickInputModal extends Modal {
	title: string;
	placeholder: string;
	initialValue: string;
	onSave: (value: string) => void;

	constructor(app: any, title: string, placeholder: string, initialValue: string, onSave: (value: string) => void) {
		super(app);
		this.title = title;
		this.placeholder = placeholder;
		this.initialValue = initialValue;
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h3', { text: this.title });

		let inputValue = this.initialValue;
		new Setting(contentEl)
			.setName(this.placeholder)
			.addText(text => text
				.setValue(this.initialValue)
				.onChange(value => inputValue = value)
				.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') {
						this.onSave(inputValue);
						this.close();
					}
				}));

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('OK')
				.setCta()
				.onClick(() => {
					this.onSave(inputValue);
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// Board Settings Modal
class BoardSettingsModal extends Modal {
	settings: BoardSettings;
	onSave: (settings: BoardSettings) => void;

	constructor(app: any, settings: BoardSettings, onSave: (settings: BoardSettings) => void) {
		super(app);
		this.settings = { ...settings };
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('kanban-board-settings-modal');

		contentEl.createEl('h2', { text: 'Board Settings' });
		contentEl.createEl('p', { text: 'These settings override global plugin settings for this board.', cls: 'setting-item-description' });

		// Display settings
		contentEl.createEl('h3', { text: 'Display' });

		new Setting(contentEl)
			.setName('Lane width')
			.setDesc('Width of lanes (e.g., 272px, 300px)')
			.addText(text => text
				.setValue(this.settings['lane-width'] || '')
				.setPlaceholder('272px')
				.onChange(value => this.settings['lane-width'] = value || undefined));

		new Setting(contentEl)
			.setName('Show checkboxes')
			.addToggle(toggle => toggle
				.setValue(this.settings['show-checkboxes'] !== false)
				.onChange(value => this.settings['show-checkboxes'] = value));

		new Setting(contentEl)
			.setName('Show card count')
			.addToggle(toggle => toggle
				.setValue(this.settings['hide-card-count'] !== true)
				.onChange(value => this.settings['hide-card-count'] = !value));

		new Setting(contentEl)
			.setName('Hide tags in title')
			.addToggle(toggle => toggle
				.setValue(this.settings['hide-tags-in-title'] || false)
				.onChange(value => this.settings['hide-tags-in-title'] = value));

		new Setting(contentEl)
			.setName('Hide dates in title')
			.addToggle(toggle => toggle
				.setValue(this.settings['hide-date-in-title'] || false)
				.onChange(value => this.settings['hide-date-in-title'] = value));

		// Metadata settings
		contentEl.createEl('h3', { text: 'Metadata' });

		new Setting(contentEl)
			.setName('Show progress')
			.addToggle(toggle => toggle
				.setValue(this.settings['show-progress'] !== false)
				.onChange(value => this.settings['show-progress'] = value));

		new Setting(contentEl)
			.setName('Show project')
			.addToggle(toggle => toggle
				.setValue(this.settings['show-project'] !== false)
				.onChange(value => this.settings['show-project'] = value));

		new Setting(contentEl)
			.setName('Default project')
			.setDesc('Default project for new cards')
			.addText(text => text
				.setValue(this.settings['default-project'] || '')
				.onChange(value => this.settings['default-project'] = value || undefined));

		// Date settings
		contentEl.createEl('h3', { text: 'Dates' });

		new Setting(contentEl)
			.setName('Date format')
			.addText(text => text
				.setValue(this.settings['date-format'] || '')
				.setPlaceholder('YYYY-MM-DD')
				.onChange(value => this.settings['date-format'] = value || undefined));

		new Setting(contentEl)
			.setName('Show relative dates')
			.addToggle(toggle => toggle
				.setValue(this.settings['show-relative-date'] || false)
				.onChange(value => this.settings['show-relative-date'] = value));

		new Setting(contentEl)
			.setName('Link dates to daily notes')
			.addToggle(toggle => toggle
				.setValue(this.settings['link-date-to-daily-note'] || false)
				.onChange(value => this.settings['link-date-to-daily-note'] = value));

		// Card settings
		contentEl.createEl('h3', { text: 'Cards' });

		new Setting(contentEl)
			.setName('New card position')
			.addDropdown(dropdown => dropdown
				.addOption('', 'Use global setting')
				.addOption('prepend', 'Top of list')
				.addOption('append', 'Bottom of list')
				.setValue(this.settings['new-card-insertion-method'] || '')
				.onChange(value => this.settings['new-card-insertion-method'] = value as any || undefined));

		new Setting(contentEl)
			.setName('Template path')
			.setDesc('Path to template file for new cards')
			.addText(text => text
				.setValue(this.settings['template-path'] || '')
				.setPlaceholder('templates/card.md')
				.onChange(value => this.settings['template-path'] = value || undefined));

		// Card Composer settings
		contentEl.createEl('h3', { text: 'Card Composer' });

		new Setting(contentEl)
			.setName('Show card composer')
			.setDesc('Show quick-add composer in lanes')
			.addToggle(toggle => toggle
				.setValue(this.settings['show-card-composer'] !== false)
				.onChange(value => this.settings['show-card-composer'] = value));

		new Setting(contentEl)
			.setName('Composer position')
			.setDesc('Where to show the quick-add composer')
			.addDropdown(dropdown => dropdown
				.addOption('bottom', 'Bottom of lane')
				.addOption('top', 'Top of lane')
				.setValue(this.settings['composer-position'] || 'bottom')
				.onChange(value => this.settings['composer-position'] = value as 'top' | 'bottom'));

		new Setting(contentEl)
			.setName('Show subtasks')
			.setDesc('Display subtask checkboxes in cards')
			.addToggle(toggle => toggle
				.setValue(this.settings['show-subtasks'] !== false)
				.onChange(value => this.settings['show-subtasks'] = value));

		// Card notes settings
		contentEl.createEl('h3', { text: 'Card Notes' });

		// Template variables help
		const templateHelp = contentEl.createDiv({ cls: 'kanban-settings-info' });
		templateHelp.createEl('span', { 
			text: 'Template variables: ', 
			cls: 'setting-item-name' 
		});
		templateHelp.createEl('span', {
			text: '{{title}}, {{date}}, {{time}}, {{project}}, {{lane}}, {{board}}, {{dueDate}}, {{tags}}, {{id}}',
			cls: 'kanban-template-var'
		});

		new Setting(contentEl)
			.setName('Card note template')
			.setDesc('Template file for dedicated card notes')
			.addText(text => text
				.setValue(this.settings['card-note-template'] || '')
				.setPlaceholder('templates/card-note.md')
				.onChange(value => this.settings['card-note-template'] = value || undefined));

		new Setting(contentEl)
			.setName('Card note folder')
			.setDesc('Folder for dedicated card notes')
			.addText(text => text
				.setValue(this.settings['card-note-folder'] || '')
				.setPlaceholder('cards/')
				.onChange(value => this.settings['card-note-folder'] = value || undefined));

		new Setting(contentEl)
			.setName('Auto-create note for new cards')
			.setDesc('Automatically create a dedicated note when adding new cards')
			.addToggle(toggle => toggle
				.setValue(this.settings['auto-create-note'] || false)
				.onChange(value => this.settings['auto-create-note'] = value));

		// Save button
		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Save')
				.setCta()
				.onClick(() => {
					// Remove undefined values
					const cleanSettings: BoardSettings = {};
					for (const [key, value] of Object.entries(this.settings)) {
						if (value !== undefined && value !== '') {
							(cleanSettings as any)[key] = value;
						}
					}
					this.onSave(cleanSettings);
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// Confirm Modal
class ConfirmModal extends Modal {
	title: string;
	message: string;
	onConfirm: () => void;

	constructor(app: any, title: string, message: string, onConfirm: () => void) {
		super(app);
		this.title = title;
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h3', { text: this.title });
		contentEl.createEl('p', { text: this.message });

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Yes')
				.setCta()
				.onClick(() => {
					this.onConfirm();
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText('No')
				.onClick(() => this.close()));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// WIP Limit Modal
class WipLimitModal extends Modal {
	lane: KanbanLane;
	currentConfig: { limit: number; warnAt?: number; blockExceeded: boolean };
	onSave: (config: { limit: number; warnAt?: number; blockExceeded: boolean }) => void;

	constructor(
		app: any, 
		lane: KanbanLane, 
		currentConfig: { limit: number; warnAt?: number; blockExceeded: boolean },
		onSave: (config: { limit: number; warnAt?: number; blockExceeded: boolean }) => void
	) {
		super(app);
		this.lane = lane;
		this.currentConfig = { ...currentConfig };
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('kanban-wip-limit-modal');

		contentEl.createEl('h2', { text: `WIP Limit: ${this.lane.title}` });
		contentEl.createEl('p', { 
			text: 'Set a Work In Progress limit for this lane. Cards exceeding the limit will show a warning.',
			cls: 'setting-item-description'
		});

		new Setting(contentEl)
			.setName('WIP limit')
			.setDesc('Maximum cards allowed (0 = no limit)')
			.addText(text => text
				.setPlaceholder('0')
				.setValue(String(this.currentConfig.limit))
				.onChange(value => {
					const limit = parseInt(value, 10);
					this.currentConfig.limit = isNaN(limit) ? 0 : Math.max(0, limit);
				}));

		new Setting(contentEl)
			.setName('Warning threshold')
			.setDesc('Show warning when this many cards (leave empty to use limit)')
			.addText(text => text
				.setPlaceholder('Same as limit')
				.setValue(this.currentConfig.warnAt ? String(this.currentConfig.warnAt) : '')
				.onChange(value => {
					const warnAt = parseInt(value, 10);
					this.currentConfig.warnAt = isNaN(warnAt) ? undefined : Math.max(0, warnAt);
				}));

		new Setting(contentEl)
			.setName('Block when exceeded')
			.setDesc('Prevent adding new cards when limit is exceeded')
			.addToggle(toggle => toggle
				.setValue(this.currentConfig.blockExceeded)
				.onChange(value => this.currentConfig.blockExceeded = value));

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Save')
				.setCta()
				.onClick(() => {
					this.onSave(this.currentConfig);
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText('Remove limit')
				.onClick(() => {
					this.onSave({ limit: 0, blockExceeded: false });
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// Note Link Modal - for linking a card to an existing note
class NoteLinkModal extends Modal {
	onSelect: (notePath: string | null) => void;
	searchInput: HTMLInputElement;
	resultsEl: HTMLElement;
	allNotes: TFile[] = [];

	constructor(app: any, onSelect: (notePath: string | null) => void) {
		super(app);
		this.onSelect = onSelect;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('kanban-note-link-modal');

		contentEl.createEl('h2', { text: 'Link to Note' });
		contentEl.createEl('p', { 
			text: 'Search for an existing note to link to this card.',
			cls: 'setting-item-description'
		});

		// Search input
		this.searchInput = contentEl.createEl('input', {
			type: 'text',
			cls: 'note-link-search',
			attr: { placeholder: 'Search notes...' }
		});
		
		this.searchInput.addEventListener('input', () => this.updateResults());
		
		// Results container
		this.resultsEl = contentEl.createDiv({ cls: 'note-link-results' });

		// Load all notes
		this.loadNotes();
		
		// Focus search
		this.searchInput.focus();

		// Cancel button
		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => {
					this.onSelect(null);
					this.close();
				}));
	}

	private loadNotes(): void {
		this.allNotes = this.app.vault.getMarkdownFiles()
			.sort((a: TFile, b: TFile) => b.stat.mtime - a.stat.mtime); // Most recent first
		this.updateResults();
	}

	private updateResults(): void {
		this.resultsEl.empty();
		const query = this.searchInput.value.toLowerCase();
		
		const filtered = this.allNotes
			.filter((file: TFile) => 
				file.basename.toLowerCase().includes(query) ||
				file.path.toLowerCase().includes(query)
			)
			.slice(0, 20); // Limit to 20 results

		if (filtered.length === 0) {
			this.resultsEl.createEl('p', { 
				text: query ? 'No matching notes found' : 'Start typing to search notes',
				cls: 'note-link-empty'
			});
			return;
		}

		for (const file of filtered) {
			const itemEl = this.resultsEl.createDiv({ cls: 'note-link-item' });
			itemEl.createEl('strong', { text: file.basename });
			itemEl.createEl('span', { text: file.path, cls: 'note-link-path' });
			
			itemEl.addEventListener('click', () => {
				this.onSelect(file.path);
				this.close();
			});
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
