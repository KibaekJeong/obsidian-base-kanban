import { App, PluginSettingTab, Setting } from 'obsidian';
import type KanbanPlugin from './main';
import { KanbanPluginSettings, DEFAULT_SETTINGS, DEFAULT_BASE_SYNC_CONFIG, DEFAULT_GPT_TASK_MANAGER_CONFIG, GPT_TASK_MANAGER_LANE_MAPPING, ConflictResolution } from './types';

export class KanbanSettingTab extends PluginSettingTab {
	plugin: KanbanPlugin;

	constructor(app: App, plugin: KanbanPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h1', { text: 'Kanban Settings' });

		// ========== Display Settings ==========
		containerEl.createEl('h2', { text: 'Display' });

		new Setting(containerEl)
			.setName('Default lane width')
			.setDesc('Default width for lanes (e.g., 272px, 300px, 20rem)')
			.addText((text) =>
				text
					.setPlaceholder('272px')
					.setValue(this.plugin.settings['default-lane-width'])
					.onChange(async (value) => {
						this.plugin.settings['default-lane-width'] = value || DEFAULT_SETTINGS['default-lane-width'];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Show checkboxes')
			.setDesc('Show completion checkboxes on cards')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['show-checkboxes'])
					.onChange(async (value) => {
						this.plugin.settings['show-checkboxes'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Show card menu')
			.setDesc('Show the menu button on cards')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['show-card-menu'])
					.onChange(async (value) => {
						this.plugin.settings['show-card-menu'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Hide tags in card titles')
			.setDesc('Hide #tags from displaying inline in card titles (still shown as pills)')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['hide-tags-in-title'])
					.onChange(async (value) => {
						this.plugin.settings['hide-tags-in-title'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Hide dates in card titles')
			.setDesc('Hide @dates from displaying inline in card titles (still shown as pills)')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['hide-date-in-title'])
					.onChange(async (value) => {
						this.plugin.settings['hide-date-in-title'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Hide metadata in card titles')
			.setDesc('Hide [key::value] metadata from displaying inline (still shown as pills)')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['hide-metadata-in-title'])
					.onChange(async (value) => {
						this.plugin.settings['hide-metadata-in-title'] = value;
						await this.plugin.saveSettings();
					})
			);

		// ========== Metadata Settings ==========
		containerEl.createEl('h2', { text: 'Metadata (Base Integration)' });

		new Setting(containerEl)
			.setName('Show progress')
			.setDesc('Display progress percentage on cards')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['show-progress'])
					.onChange(async (value) => {
						this.plugin.settings['show-progress'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Show project')
			.setDesc('Display project name on cards')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['show-project'])
					.onChange(async (value) => {
						this.plugin.settings['show-project'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Default project')
			.setDesc('Default project name for new cards (leave empty for none)')
			.addText((text) =>
				text
					.setPlaceholder('')
					.setValue(this.plugin.settings['default-project'])
					.onChange(async (value) => {
						this.plugin.settings['default-project'] = value;
						await this.plugin.saveSettings();
					})
			);

		// ========== Card Settings ==========
		containerEl.createEl('h2', { text: 'Cards' });

		new Setting(containerEl)
			.setName('New card insertion method')
			.setDesc('Where to insert new cards in a lane')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('prepend', 'At the top')
					.addOption('append', 'At the bottom')
					.setValue(this.plugin.settings['new-card-insertion-method'])
					.onChange(async (value: 'prepend' | 'append') => {
						this.plugin.settings['new-card-insertion-method'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Template path')
			.setDesc('Path to a template file for creating new cards (e.g., templates/card-template.md)')
			.addText((text) =>
				text
					.setPlaceholder('templates/card-template.md')
					.setValue(this.plugin.settings['template-path'])
					.onChange(async (value) => {
						this.plugin.settings['template-path'] = value;
						await this.plugin.saveSettings();
					})
			);

		// ========== Card Composer Settings ==========
		containerEl.createEl('h2', { text: 'Card Composer' });

		new Setting(containerEl)
			.setName('Show card composer')
			.setDesc('Show quick-add composer in lanes for rapid card creation')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['show-card-composer'])
					.onChange(async (value) => {
						this.plugin.settings['show-card-composer'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Composer position')
			.setDesc('Where to show the quick-add composer in lanes')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('bottom', 'Bottom of lane')
					.addOption('top', 'Top of lane')
					.setValue(this.plugin.settings['composer-position'])
					.onChange(async (value: 'top' | 'bottom') => {
						this.plugin.settings['composer-position'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Show subtasks')
			.setDesc('Display subtask checkboxes in card view')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['show-subtasks'])
					.onChange(async (value) => {
						this.plugin.settings['show-subtasks'] = value;
						await this.plugin.saveSettings();
					})
			);

		// ========== Filtering Settings ==========
		containerEl.createEl('h2', { text: 'Filtering' });

		new Setting(containerEl)
			.setName('Show filter toolbar')
			.setDesc('Display filter toolbar at the top of boards for searching and filtering cards')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['show-filter-toolbar'])
					.onChange(async (value) => {
						this.plugin.settings['show-filter-toolbar'] = value;
						await this.plugin.saveSettings();
					})
			);

		// ========== WIP Limits Settings ==========
		containerEl.createEl('h2', { text: 'WIP Limits' });

		containerEl.createEl('p', { 
			text: 'Work In Progress limits help manage workflow by limiting cards per lane. Configure per-lane limits in board settings.',
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('Default WIP limit')
			.setDesc('Default maximum cards per lane (0 = no limit). Can be overridden per-lane.')
			.addText((text) =>
				text
					.setPlaceholder('0')
					.setValue(String(this.plugin.settings['default-wip-limit']))
					.onChange(async (value) => {
						const limit = parseInt(value, 10);
						this.plugin.settings['default-wip-limit'] = isNaN(limit) ? 0 : Math.max(0, limit);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Block when exceeded')
			.setDesc('Prevent adding new cards when a lane exceeds its WIP limit')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['wip-block-exceeded'])
					.onChange(async (value) => {
						this.plugin.settings['wip-block-exceeded'] = value;
						await this.plugin.saveSettings();
					})
			);

		// ========== Card Notes Settings ==========
		containerEl.createEl('h2', { text: 'Card Notes' });

		// Template variables documentation
		const templateVarsEl = containerEl.createDiv({ cls: 'kanban-settings-info' });
		templateVarsEl.createEl('p', { 
			text: 'Available template variables:', 
			cls: 'setting-item-name' 
		});
		const varsList = templateVarsEl.createEl('ul', { cls: 'kanban-template-vars-list' });
		const templateVars = [
			'{{title}} - Card title',
			'{{id}} - Unique card ID',
			'{{date}} - Current date (YYYY-MM-DD)',
			'{{time}} - Current time (HH:mm)',
			'{{datetime}} - Full ISO datetime',
			'{{dueDate}} - Card due date',
			'{{project}} - Project name',
			'{{priority}} - Priority level',
			'{{tags}} - Card tags (comma-separated)',
			'{{board}} - Board name',
			'{{lane}} - Lane name',
			'{{date:FORMAT}} - Custom date format (e.g., {{date:MMMM DD, YYYY}})',
			'{{variable|default}} - Variable with default value',
		];
		for (const varDesc of templateVars) {
			varsList.createEl('li', { text: varDesc, cls: 'kanban-template-var' });
		}

		new Setting(containerEl)
			.setName('Card note template')
			.setDesc('Template file for dedicated card notes')
			.addText((text) =>
				text
					.setPlaceholder('templates/card-note.md')
					.setValue(this.plugin.settings['card-note-template'])
					.onChange(async (value) => {
						this.plugin.settings['card-note-template'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Card note folder')
			.setDesc('Default folder for dedicated card notes. Leave empty to use the same folder as the board.')
			.addText((text) =>
				text
					.setPlaceholder('cards/')
					.setValue(this.plugin.settings['card-note-folder'])
					.onChange(async (value) => {
						this.plugin.settings['card-note-folder'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Auto-create note for new cards')
			.setDesc('Automatically create a dedicated note file when adding new cards')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['auto-create-note'])
					.onChange(async (value) => {
						this.plugin.settings['auto-create-note'] = value;
						await this.plugin.saveSettings();
					})
			);

		// ========== Date Settings ==========
		containerEl.createEl('h2', { text: 'Dates' });

		new Setting(containerEl)
			.setName('Date format')
			.setDesc('Format for displaying dates (YYYY-MM-DD, DD/MM/YYYY, etc.)')
			.addText((text) =>
				text
					.setPlaceholder('YYYY-MM-DD')
					.setValue(this.plugin.settings['date-format'])
					.onChange(async (value) => {
						this.plugin.settings['date-format'] = value || DEFAULT_SETTINGS['date-format'];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Time format')
			.setDesc('Format for displaying times (HH:mm, hh:mm A, etc.)')
			.addText((text) =>
				text
					.setPlaceholder('HH:mm')
					.setValue(this.plugin.settings['time-format'])
					.onChange(async (value) => {
						this.plugin.settings['time-format'] = value || DEFAULT_SETTINGS['time-format'];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Date trigger')
			.setDesc('Character to trigger date input (e.g., @)')
			.addText((text) =>
				text
					.setPlaceholder('@')
					.setValue(this.plugin.settings['date-trigger'])
					.onChange(async (value) => {
						this.plugin.settings['date-trigger'] = value || DEFAULT_SETTINGS['date-trigger'];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Time trigger')
			.setDesc('Character to trigger time input (e.g., @@)')
			.addText((text) =>
				text
					.setPlaceholder('@@')
					.setValue(this.plugin.settings['time-trigger'])
					.onChange(async (value) => {
						this.plugin.settings['time-trigger'] = value || DEFAULT_SETTINGS['time-trigger'];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Link dates to daily notes')
			.setDesc('Make dates clickable to open corresponding daily notes')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['link-date-to-daily-note'])
					.onChange(async (value) => {
						this.plugin.settings['link-date-to-daily-note'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Show relative dates')
			.setDesc('Display dates as "Today", "Tomorrow", "In 3 days", etc.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['show-relative-date'])
					.onChange(async (value) => {
						this.plugin.settings['show-relative-date'] = value;
						await this.plugin.saveSettings();
					})
			);

		// ========== Natural Language Date Parsing ==========
		containerEl.createEl('h2', { text: 'Natural Language Dates' });

		new Setting(containerEl)
			.setName('Parse natural language dates')
			.setDesc('Automatically convert phrases like "today", "tomorrow", "next Monday", "in 3 days" to dates')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['parse-natural-dates'])
					.onChange(async (value) => {
						this.plugin.settings['parse-natural-dates'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Parse recurrence patterns')
			.setDesc('Recognize patterns like "daily", "every Monday", "weekly", "every 2 weeks"')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['parse-recurrence'])
					.onChange(async (value) => {
						this.plugin.settings['parse-recurrence'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Date serialization format')
			.setDesc('How dates are saved in markdown (ISO format recommended for compatibility)')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('iso', 'ISO format (2024-01-15)')
					.addOption('natural', 'Natural language (tomorrow)')
					.setValue(this.plugin.settings['date-serialization-format'])
					.onChange(async (value: 'iso' | 'natural') => {
						this.plugin.settings['date-serialization-format'] = value;
						await this.plugin.saveSettings();
					})
			);

		// ========== Reminders ==========
		containerEl.createEl('h2', { text: 'Reminders' });

		new Setting(containerEl)
			.setName('Enable reminders')
			.setDesc('Show notifications when cards are approaching their due dates')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['enable-reminders'])
					.onChange(async (value) => {
						this.plugin.settings['enable-reminders'] = value;
						await this.plugin.saveSettings();
						this.plugin.restartReminders();
					})
			);

		new Setting(containerEl)
			.setName('Default reminder time')
			.setDesc('How long before due date to show reminder (e.g., 30m, 1h, 2h, 1d)')
			.addText((text) =>
				text
					.setPlaceholder('1h')
					.setValue(this.plugin.settings['reminder-time'])
					.onChange(async (value) => {
						this.plugin.settings['reminder-time'] = value || DEFAULT_SETTINGS['reminder-time'];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Reminder type')
			.setDesc('How to show reminders')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('notice', 'Obsidian notice (in-app)')
					.addOption('system', 'System notification (desktop)')
					.setValue(this.plugin.settings['reminder-type'])
					.onChange(async (value: 'notice' | 'system') => {
						this.plugin.settings['reminder-type'] = value;
						await this.plugin.saveSettings();
					})
			);

		// ========== Archive Settings ==========
		containerEl.createEl('h2', { text: 'Archive' });

		new Setting(containerEl)
			.setName('Prepend archive date')
			.setDesc('Add the archive date to the beginning of archived card titles')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings['prepend-archive-date'])
					.onChange(async (value) => {
						this.plugin.settings['prepend-archive-date'] = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Archive date format')
			.setDesc('Format for prepended archive dates')
			.addText((text) =>
				text
					.setPlaceholder('YYYY-MM-DD')
					.setValue(this.plugin.settings['prepend-archive-format'])
					.onChange(async (value) => {
						this.plugin.settings['prepend-archive-format'] = value || DEFAULT_SETTINGS['prepend-archive-format'];
						await this.plugin.saveSettings();
					})
			);

		// ========== Base Sync Settings ==========
		containerEl.createEl('h2', { text: 'Base Task Sync' });

		const syncConfig = this.plugin.settings['base-sync'];

		new Setting(containerEl)
			.setName('Enable Base sync')
			.setDesc('Sync cards with Base task files. When enabled, moving cards updates task status fields.')
			.addToggle((toggle) =>
				toggle
					.setValue(syncConfig.enabled)
					.onChange(async (value) => {
						this.plugin.settings['base-sync'].enabled = value;
						await this.plugin.saveSettings();
						this.display(); // Refresh to show/hide dependent settings
					})
			);

		if (syncConfig.enabled) {
			new Setting(containerEl)
				.setName('Tasks folder')
				.setDesc('Folder containing Base task files')
				.addText((text) =>
					text
						.setPlaceholder('Tasks')
						.setValue(syncConfig.tasksFolder)
						.onChange(async (value) => {
							this.plugin.settings['base-sync'].tasksFolder = value || 'Tasks';
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('Task query')
				.setDesc('Filter tasks to sync (e.g., "project:MyProject", "status:todo", "tag:work")')
				.addText((text) =>
					text
						.setPlaceholder('Leave empty for all tasks')
						.setValue(syncConfig.query)
						.onChange(async (value) => {
							this.plugin.settings['base-sync'].query = value;
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('Status field')
				.setDesc('Frontmatter field name for task status')
				.addText((text) =>
					text
						.setPlaceholder('status')
						.setValue(syncConfig.statusField)
						.onChange(async (value) => {
							this.plugin.settings['base-sync'].statusField = value || 'status';
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('Progress field')
				.setDesc('Frontmatter field name for task progress')
				.addText((text) =>
					text
						.setPlaceholder('progress')
						.setValue(syncConfig.progressField)
						.onChange(async (value) => {
							this.plugin.settings['base-sync'].progressField = value || 'progress';
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('Project field')
				.setDesc('Frontmatter field name for task project')
				.addText((text) =>
					text
						.setPlaceholder('project')
						.setValue(syncConfig.projectField)
						.onChange(async (value) => {
							this.plugin.settings['base-sync'].projectField = value || 'project';
							await this.plugin.saveSettings();
						})
				);

		new Setting(containerEl)
			.setName('Conflict resolution')
			.setDesc('How to handle conflicts between local cards and remote tasks')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('local', 'Keep local (card) values')
					.addOption('remote', 'Use remote (Base) values')
					.addOption('last-write', 'Last write wins (most recent modification)')
					.addOption('prompt', 'Ask me each time')
					.setValue(syncConfig.conflictResolution)
					.onChange(async (value: string) => {
						this.plugin.settings['base-sync'].conflictResolution = value as ConflictResolution;
						await this.plugin.saveSettings();
					})
			);

			new Setting(containerEl)
				.setName('Auto-sync interval')
				.setDesc('Minutes between auto-syncs (0 = manual only)')
				.addText((text) =>
					text
						.setPlaceholder('0')
						.setValue(syncConfig.syncInterval.toString())
						.onChange(async (value) => {
							const interval = parseInt(value, 10);
							this.plugin.settings['base-sync'].syncInterval = isNaN(interval) ? 0 : Math.max(0, interval);
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('Create missing tasks')
				.setDesc('Automatically create Base task files for cards without a linked task')
				.addToggle((toggle) =>
					toggle
						.setValue(syncConfig.createMissingTasks)
						.onChange(async (value) => {
							this.plugin.settings['base-sync'].createMissingTasks = value;
							await this.plugin.saveSettings();
						})
				);

			// Lane mapping configuration
			containerEl.createEl('h3', { text: 'Lane → Status Mapping' });
			containerEl.createEl('p', { 
				text: 'Map lane titles to Base status values. When a card moves to a lane, its status will be updated.', 
				cls: 'setting-item-description' 
			});

			const mappingContainer = containerEl.createDiv({ cls: 'kanban-lane-mapping' });
			
			// Display existing mappings
			for (const [laneTitle, statusValue] of Object.entries(syncConfig.laneMapping)) {
				this.createMappingRow(mappingContainer, laneTitle, statusValue);
			}

			// Add new mapping button
			new Setting(containerEl)
				.setName('Add mapping')
				.setDesc('Add a new lane → status mapping')
				.addButton((btn) =>
					btn
						.setButtonText('+ Add mapping')
						.onClick(() => {
							this.createMappingRow(mappingContainer, '', '');
						})
				);
		}

		// ========== GPT Task Manager Integration ==========
		containerEl.createEl('h2', { text: 'GPT Task Manager Integration' });

		const gptConfig = this.plugin.settings['gpt-task-manager'];

		containerEl.createEl('p', { 
			text: 'Integrate with GPT Task Manager plugin to view and manage tasks in Kanban format. When enabled, tasks created by GPT Task Manager can be displayed as Kanban cards.',
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('Enable GPT Task Manager integration')
			.setDesc('Sync cards with GPT Task Manager task files. Moving cards will update task status.')
			.addToggle((toggle) =>
				toggle
					.setValue(gptConfig.enabled)
					.onChange(async (value) => {
						this.plugin.settings['gpt-task-manager'].enabled = value;
						
						// Auto-configure Base Sync when GPT integration is enabled
						if (value) {
							const baseSyncConfig = this.plugin.settings['base-sync'];
							baseSyncConfig.enabled = true;
							baseSyncConfig.tasksFolder = gptConfig.tasksFolder;
							baseSyncConfig.statusField = gptConfig.statusField;
							baseSyncConfig.projectField = gptConfig.projectField;
							baseSyncConfig.laneMapping = { ...GPT_TASK_MANAGER_LANE_MAPPING };
						}
						
						await this.plugin.saveSettings();
						this.display(); // Refresh to show/hide dependent settings
					})
			);

		if (gptConfig.enabled) {
			new Setting(containerEl)
				.setName('Tasks folder')
				.setDesc('Folder containing GPT Task Manager task files')
				.addText((text) =>
					text
						.setPlaceholder('500 Plan & Reflect/520 Tasks')
						.setValue(gptConfig.tasksFolder)
						.onChange(async (value) => {
							this.plugin.settings['gpt-task-manager'].tasksFolder = value || DEFAULT_GPT_TASK_MANAGER_CONFIG.tasksFolder;
							// Also update Base Sync folder
							this.plugin.settings['base-sync'].tasksFolder = value || DEFAULT_GPT_TASK_MANAGER_CONFIG.tasksFolder;
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('Epics folder')
				.setDesc('Folder containing GPT Task Manager epic files')
				.addText((text) =>
					text
						.setPlaceholder('500 Plan & Reflect/510 Epics')
						.setValue(gptConfig.epicsFolder)
						.onChange(async (value) => {
							this.plugin.settings['gpt-task-manager'].epicsFolder = value || DEFAULT_GPT_TASK_MANAGER_CONFIG.epicsFolder;
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('Projects folder')
				.setDesc('Folder containing GPT Task Manager project files')
				.addText((text) =>
					text
						.setPlaceholder('400 Projects')
						.setValue(gptConfig.projectsFolder)
						.onChange(async (value) => {
							this.plugin.settings['gpt-task-manager'].projectsFolder = value || DEFAULT_GPT_TASK_MANAGER_CONFIG.projectsFolder;
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('Status field')
				.setDesc('Frontmatter field name for task status (case-sensitive)')
				.addText((text) =>
					text
						.setPlaceholder('Status')
						.setValue(gptConfig.statusField)
						.onChange(async (value) => {
							this.plugin.settings['gpt-task-manager'].statusField = value || 'Status';
							this.plugin.settings['base-sync'].statusField = value || 'Status';
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('Update status on card move')
				.setDesc('Automatically update task status when a card is moved between lanes')
				.addToggle((toggle) =>
					toggle
						.setValue(gptConfig.updateStatusOnMove)
						.onChange(async (value) => {
							this.plugin.settings['gpt-task-manager'].updateStatusOnMove = value;
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('Sync checklist items')
				.setDesc('Display the task\'s ## 🔄 Sync checklist item as the card title')
				.addToggle((toggle) =>
					toggle
						.setValue(gptConfig.syncChecklistToBoard)
						.onChange(async (value) => {
							this.plugin.settings['gpt-task-manager'].syncChecklistToBoard = value;
							await this.plugin.saveSettings();
						})
				);

			// Status values configuration
			containerEl.createEl('h3', { text: 'Status Values' });
			containerEl.createEl('p', { 
				text: 'Configure the status values used by GPT Task Manager. These should match the Status field values in your task files.',
				cls: 'setting-item-description'
			});

			new Setting(containerEl)
				.setName('Backlog status value')
				.setDesc('Status value for tasks in the Backlog lane')
				.addText((text) =>
					text
						.setPlaceholder('backlog')
						.setValue(gptConfig.statusValues.backlog)
						.onChange(async (value) => {
							this.plugin.settings['gpt-task-manager'].statusValues.backlog = value || 'backlog';
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('To Do status value')
				.setDesc('Status value for tasks in the To Do lane')
				.addText((text) =>
					text
						.setPlaceholder('todo')
						.setValue(gptConfig.statusValues.todo)
						.onChange(async (value) => {
							this.plugin.settings['gpt-task-manager'].statusValues.todo = value || 'todo';
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('In Progress status value')
				.setDesc('Status value for tasks in the In Progress lane')
				.addText((text) =>
					text
						.setPlaceholder('in-progress')
						.setValue(gptConfig.statusValues.inProgress)
						.onChange(async (value) => {
							this.plugin.settings['gpt-task-manager'].statusValues.inProgress = value || 'in-progress';
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName('Done status value')
				.setDesc('Status value for tasks in the Done lane')
				.addText((text) =>
					text
						.setPlaceholder('done')
						.setValue(gptConfig.statusValues.done)
						.onChange(async (value) => {
							this.plugin.settings['gpt-task-manager'].statusValues.done = value || 'done';
							await this.plugin.saveSettings();
						})
				);
		}

		// ========== About ==========
		containerEl.createEl('h2', { text: 'About' });
		
		const aboutEl = containerEl.createDiv({ cls: 'kanban-settings-about' });
		aboutEl.createEl('p', { 
			text: 'Base Kanban is a markdown-backed Kanban board plugin with support for Obsidian Base task metadata.' 
		});
		aboutEl.createEl('p', { 
			text: 'Per-board settings can override these global settings. Access board settings from the board menu (three dots in the header) or via the command palette.' 
		});
		aboutEl.createEl('p', { 
			text: 'GPT Task Manager integration allows viewing tasks created by GPT Task Manager in Kanban format. Use the command palette to create boards from Epics or Projects.' 
		});
	}

	private createMappingRow(container: HTMLElement, laneTitle: string, statusValue: string): void {
		const rowEl = container.createDiv({ cls: 'kanban-mapping-row' });
		
		const laneInput = rowEl.createEl('input', {
			type: 'text',
			cls: 'kanban-mapping-lane',
			attr: { placeholder: 'Lane title' }
		});
		laneInput.value = laneTitle;

		rowEl.createSpan({ text: '→', cls: 'kanban-mapping-arrow' });

		const statusInput = rowEl.createEl('input', {
			type: 'text',
			cls: 'kanban-mapping-status',
			attr: { placeholder: 'Status value' }
		});
		statusInput.value = statusValue;

		const deleteBtn = rowEl.createEl('button', { cls: 'kanban-mapping-delete' });
		deleteBtn.textContent = '×';

		// Save on change
		const saveMapping = async () => {
			const newLane = laneInput.value.trim();
			const newStatus = statusInput.value.trim();
			
			// Remove old mapping if lane changed
			if (laneTitle && laneTitle !== newLane) {
				delete this.plugin.settings['base-sync'].laneMapping[laneTitle];
			}
			
			// Add new mapping
			if (newLane && newStatus) {
				this.plugin.settings['base-sync'].laneMapping[newLane] = newStatus;
			}
			
			await this.plugin.saveSettings();
		};

		laneInput.addEventListener('change', saveMapping);
		statusInput.addEventListener('change', saveMapping);

		// Delete mapping
		deleteBtn.addEventListener('click', async () => {
			const lane = laneInput.value.trim();
			if (lane && this.plugin.settings['base-sync'].laneMapping[lane]) {
				delete this.plugin.settings['base-sync'].laneMapping[lane];
				await this.plugin.saveSettings();
			}
			rowEl.remove();
		});
	}
}
