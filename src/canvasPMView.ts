import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import {
    getCanvas,
    getCanvasData,
    getNodeText,
    autoResizeNodes,
    computeStats,
    countWords,
    buildHierarchy,
    countDescendants,
    getNodeDisplayName,
    zoomToNode,
    extractTags,
    hasAnyTask,
    hasUnfinishedTask,
    isFullyComplete,
    TreeNode,
} from './canvasUtils';

export const VIEW_TYPE_CANVAS_PM = 'canvas-pm-sidebar';

interface FilterState {
    selectedTags: Set<string>;
    taskMode: 'none' | 'unfinished' | 'completed';
    searchQuery: string;
}

export class CanvasPMView extends ItemView {
    private filter: FilterState = {
        selectedTags: new Set(),
        taskMode: 'none',
        searchQuery: '',
    };

    // Toolbar
    private toolbarEl:     HTMLElement | null = null;
    private tagDropdownEl: HTMLElement | null = null;
    private taskWrapEl:    HTMLElement | null = null;
    private tagsBtnEl:     HTMLButtonElement | null = null;

    // Sidebar
    private infoLineEl!:  HTMLElement;
    private hierarchyEl!: HTMLElement;
    private searchDebounce = 0;

    // Filter state persisted across hierarchy refreshes
    private lastMatchedIds   = new Set<string>();
    private lastFilterActive = false;

    // MutationObserver to re-apply dimming when canvas re-renders nodes
    private canvasObserver: MutationObserver | null = null;
    private reapplyDebounce = 0;

    constructor(leaf: WorkspaceLeaf) { super(leaf); }

    getViewType()    { return VIEW_TYPE_CANVAS_PM; }
    getDisplayText() { return 'Canvas PM'; }
    getIcon()        { return 'layout-dashboard'; }

    async onOpen() {
        this.buildSidebar();
        this.injectToolbar();

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.injectToolbar();
                this.refreshInfoLine();
                this.reapplyFilters();
            })
        );
        this.registerEvent(
            this.app.workspace.on('file-open', file => {
                if (file?.extension === 'canvas') {
                    this.injectToolbar();
                    this.refreshInfoLine();
                    // Auto-load hierarchy on new canvas
                    this.refreshHierarchy();
                }
            })
        );

        this.registerInterval(window.setInterval(() => this.refreshInfoLine(), 5000));
        this.registerInterval(window.setInterval(() => {
            if (this.hierarchyEl?.querySelector('.cpm-tree-node')) this.refreshHierarchy();
        }, 20000));
    }

    async onClose() {
        this.removeToolbar();
        this.canvasObserver?.disconnect();
        this.canvasObserver = null;
    }

    // ─── Sidebar ───────────────────────────────────────────────────────────────

    private buildSidebar() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('canvas-pm');
        contentEl.createEl('div', { cls: 'canvas-pm-header', text: 'Canvas PM' });

        this.infoLineEl = contentEl.createDiv({ cls: 'cpm-info-line' });
        this.refreshInfoLine();

        this.buildHierarchySection(contentEl);
    }

    private refreshInfoLine() {
        if (!this.infoLineEl) return;
        const canvas = getCanvas(this.app);
        if (!canvas) { this.infoLineEl.textContent = 'No canvas open'; return; }
        try {
            const n   = getCanvasData(canvas).nodes.length;
            const w   = countWords(canvas);
            const sel = (canvas.selection as Set<unknown>)?.size ?? 0;
            const selPart = sel > 0 ? ` · ${sel} selected` : '';
            this.infoLineEl.textContent = `${n} nodes · ${w.toLocaleString()} words${selPart}`;
        } catch (_) {}
    }

    // ─── Hierarchy section ─────────────────────────────────────────────────────

    private buildHierarchySection(parent: HTMLElement) {
        const wrap = parent.createDiv({ cls: 'cpm-section' });
        const head = wrap.createDiv({ cls: 'cpm-section-head' });
        head.createEl('span', { cls: 'cpm-section-title', text: '🌲 Hierarchy' });
        const chevron = head.createEl('span', { cls: 'cpm-chevron', text: '▾' });
        const body = wrap.createDiv({ cls: 'cpm-section-body' });

        head.addEventListener('click', () => {
            body.toggleClass('cpm-collapsed', !body.hasClass('cpm-collapsed'));
            chevron.textContent = body.hasClass('cpm-collapsed') ? '▸' : '▾';
        });

        // Sub-header: hint + expand/collapse all + refresh
        const subHead = body.createDiv({ cls: 'cpm-row cpm-sub-head' });
        subHead.createEl('span', { cls: 'cpm-hint', text: 'Click node to zoom' });

        const controlsRow = subHead.createDiv({ cls: 'cpm-row' });

        // Expand/collapse-all toggle
        const toggleAllBtn = controlsRow.createEl('button', {
            text: '⊟', cls: 'cpm-icon-btn', title: 'Collapse all groups',
        });
        let allCollapsed = false;
        toggleAllBtn.addEventListener('click', () => {
            allCollapsed = !allCollapsed;
            Array.from(this.hierarchyEl.querySelectorAll<HTMLElement>('.cpm-tree-children'))
                .forEach(el => el.classList.toggle('cpm-tree-collapsed', allCollapsed));
            Array.from(this.hierarchyEl.querySelectorAll<HTMLElement>('.cpm-tree-chevron'))
                .forEach(el => { el.textContent = allCollapsed ? '▶' : '▼'; });
            toggleAllBtn.textContent = allCollapsed ? '⊞' : '⊟';
            toggleAllBtn.title = allCollapsed ? 'Expand all groups' : 'Collapse all groups';
        });

        const refreshBtn = controlsRow.createEl('button', {
            text: '↻', cls: 'cpm-icon-btn', title: 'Refresh hierarchy',
        });
        refreshBtn.addEventListener('click', () => this.refreshHierarchy(refreshBtn));

        this.hierarchyEl = body.createDiv({ cls: 'cpm-hierarchy' });
        this.hierarchyEl.createEl('p', { cls: 'cpm-hint', text: 'Loading…' });
    }

    private refreshHierarchy(btn?: HTMLButtonElement) {
        if (!this.hierarchyEl) return;
        if (btn) { btn.disabled = true; btn.textContent = '…'; }

        this.hierarchyEl.empty();
        const s = this.hierarchyEl.createDiv({ cls: 'cpm-loading' });
        s.createDiv({ cls: 'cpm-spinner' });
        s.createEl('span', { text: 'Computing…' });

        window.setTimeout(() => {
            if (btn) { btn.disabled = false; btn.textContent = '↻'; }
            this.hierarchyEl.empty();
            const canvas = getCanvas(this.app);
            if (!canvas) {
                this.hierarchyEl.createEl('p', { cls: 'cpm-hint', text: 'No canvas open.' });
                return;
            }
            try {
                const tree = buildHierarchy(getCanvasData(canvas).nodes);
                if (!tree.length) {
                    this.hierarchyEl.createEl('p', { cls: 'cpm-hint', text: 'No nodes.' });
                    return;
                }
                this.renderTreeNodes(tree, this.hierarchyEl);
                // Re-apply current filter state to newly rendered rows
                this.syncHierarchyDimming();
            } catch (_) {
                this.hierarchyEl.createEl('p', { cls: 'cpm-hint', text: 'Error.' });
            }
        }, 0);
    }

    private renderTreeNodes(nodes: TreeNode[], container: HTMLElement) {
        for (const t of nodes) {
            const { node, children } = t;
            const isGroup = node.type === 'group';
            const text    = getNodeText(node);
            const name    = getNodeDisplayName(node);

            if (isGroup) {
                // Groups get a collapsible wrapper
                const groupWrap = container.createDiv({ cls: 'cpm-tree-group-wrap' });

                const row = groupWrap.createDiv({ cls: 'cpm-tree-node cpm-tree-group' });
                row.dataset['nodeId'] = node.id;

                // Chevron on the far left — toggles children visibility
                const chevron = row.createEl('button', { cls: 'cpm-tree-chevron', text: '▼' });
                chevron.addEventListener('click', e => {
                    e.stopPropagation();
                    const childEl = groupWrap.querySelector<HTMLElement>('.cpm-tree-children');
                    if (!childEl) return;
                    const collapsed = childEl.classList.toggle('cpm-tree-collapsed');
                    chevron.textContent = collapsed ? '▶' : '▼';
                });

                row.createEl('span', {
                    cls: node.color ? `cpm-node-dot cpm-dot-${node.color}` : 'cpm-node-dot',
                });
                const label = row.createEl('span', {
                    cls: 'cpm-tree-label cpm-tree-group-label', text: name,
                });
                row.createEl('span', { cls: 'cpm-tree-count', text: String(countDescendants(t)) });
                if (hasAnyTask(text)) {
                    const done = isFullyComplete(text);
                    row.createEl('span', {
                        cls: 'cpm-task-icon ' + (done ? 'cpm-task-icon-done' : 'cpm-task-icon-open'),
                        title: done ? 'All tasks done' : 'Has unfinished tasks',
                        text: done ? '●' : '○',
                    });
                }
                row.addEventListener('click', () => this.zoomToNodeById(node.id));

                // Children container (indented)
                if (children.length > 0) {
                    const childrenEl = groupWrap.createDiv({ cls: 'cpm-tree-children' });
                    this.renderTreeNodes(children, childrenEl);
                }
            } else {
                // Regular node
                const row = container.createDiv({ cls: 'cpm-tree-node' });
                row.dataset['nodeId'] = node.id;
                // Placeholder indent to align with groups that have a chevron
                row.createEl('span', { cls: 'cpm-tree-chevron-gap' });

                row.createEl('span', {
                    cls: node.color ? `cpm-node-dot cpm-dot-${node.color}` : 'cpm-node-dot',
                });
                row.createEl('span', { cls: 'cpm-tree-label', text: name });
                if (hasAnyTask(text)) {
                    const done = isFullyComplete(text);
                    row.createEl('span', {
                        cls: 'cpm-task-icon ' + (done ? 'cpm-task-icon-done' : 'cpm-task-icon-open'),
                        title: done ? 'All tasks done' : 'Has unfinished tasks',
                        text: done ? '●' : '○',
                    });
                }
                row.title = 'Click to zoom';
                row.addEventListener('click', () => this.zoomToNodeById(node.id));

                // Children shouldn't exist for non-groups, but render if present
                if (children.length > 0) this.renderTreeNodes(children, container);
            }
        }
    }

    private zoomToNodeById(id: string) {
        const canvas = getCanvas(this.app);
        if (!canvas) return;
        const live = getCanvasData(canvas).nodes.find(n => n.id === id);
        if (live) zoomToNode(canvas, live);
    }

    // ─── Canvas toolbar ────────────────────────────────────────────────────────

    private injectToolbar() {
        // Clear dimming/glow from all canvas leaves before switching
        for (const leaf of this.app.workspace.getLeavesOfType('canvas')) {
            const c = (leaf.view as any)?.canvas;
            if (c) for (const n of (c.nodes as Map<string, any>).values()) {
                n.nodeEl?.classList.remove('cpm-node-dimmed', 'cpm-node-active');
            }
        }
        this.removeToolbar();

        const canvas = getCanvas(this.app);
        if (!canvas) return;

        const container: HTMLElement | null =
            canvas.wrapperEl ?? canvas.canvasEl?.parentElement ?? null;
        if (!container) return;

        this.toolbarEl = document.createElement('div');
        this.toolbarEl.className = 'cpm-canvas-toolbar';
        this.buildToolbar(this.toolbarEl);
        container.appendChild(this.toolbarEl);

        this.setupCanvasObserver(container);
    }

    private removeToolbar() {
        this.closeTagDropdown();
        this.canvasObserver?.disconnect();
        this.canvasObserver = null;
        this.toolbarEl?.remove();
        this.toolbarEl  = null;
        this.taskWrapEl = null;
        this.tagsBtnEl  = null;
    }

    private setupCanvasObserver(container: HTMLElement) {
        this.canvasObserver?.disconnect();

        this.canvasObserver = new MutationObserver(mutations => {
            // Re-apply dimming only when canvas-node elements are added (virtualization restores)
            const hasNewNodes = mutations.some(m =>
                Array.from(m.addedNodes).some(n =>
                    n instanceof HTMLElement &&
                    (n.classList.contains('canvas-node') || n.querySelector?.('.canvas-node'))
                )
            );
            if (!hasNewNodes) return;

            window.clearTimeout(this.reapplyDebounce);
            this.reapplyDebounce = window.setTimeout(() => this.reapplyFilters(), 60);
        });

        this.canvasObserver.observe(container, { childList: true, subtree: true });
    }

    private buildToolbar(toolbar: HTMLElement) {
        // Tags
        const tagsWrap = toolbar.createDiv({ cls: 'cpm-tb-tags-wrap' });
        this.tagsBtnEl = tagsWrap.createEl('button', { cls: 'cpm-tb-btn cpm-tb-tags-btn' });
        this.updateTagsBtnText();
        this.tagsBtnEl.addEventListener('click', e => { e.stopPropagation(); this.toggleTagDropdown(); });

        toolbar.createEl('span', { cls: 'cpm-tb-sep' });

        // Task filter
        this.taskWrapEl = toolbar.createDiv({ cls: 'cpm-tb-task-wrap' });
        this.buildTaskButtons();

        toolbar.createEl('span', { cls: 'cpm-tb-sep' });

        // Find
        const findInput = toolbar.createEl('input', {
            type: 'text', cls: 'cpm-tb-find', placeholder: 'Find…',
        });
        findInput.value = this.filter.searchQuery;
        findInput.addEventListener('input', () => {
            this.filter.searchQuery = findInput.value;
            window.clearTimeout(this.searchDebounce);
            this.searchDebounce = window.setTimeout(() => this.applyFilters(), 180);
        });

        toolbar.createEl('span', { cls: 'cpm-tb-sep' });

        // Auto-size
        toolbar.createEl('button', {
            cls: 'cpm-tb-btn cpm-tb-auto-btn', text: '⬡', title: 'Auto-size active nodes',
        }).addEventListener('click', () => this.doAutoSize());
    }

    private buildTaskButtons() {
        if (!this.taskWrapEl) return;
        this.taskWrapEl.empty();

        const canvas = getCanvas(this.app);
        let unfinished = 0, done = 0;
        if (canvas) {
            for (const n of getCanvasData(canvas).nodes) {
                const t = getNodeText(n);
                if (hasUnfinishedTask(t)) unfinished++;
                else if (isFullyComplete(t)) done++;
            }
        }

        const modes: { mode: FilterState['taskMode']; label: string; count: number | null }[] = [
            { mode: 'none',       label: 'All tasks',  count: null },
            { mode: 'unfinished', label: 'Unfinished', count: unfinished },
            { mode: 'completed',  label: 'Done',       count: done },
        ];

        for (const { mode, label, count } of modes) {
            const btn = this.taskWrapEl.createEl('button', {
                cls: 'cpm-tb-btn cpm-tb-task-btn' + (mode === this.filter.taskMode ? ' cpm-tb-active' : ''),
            });
            btn.createEl('span', { text: label });
            if (count !== null) btn.createEl('span', { cls: 'cpm-tb-count', text: String(count) });
            btn.addEventListener('click', () => {
                this.filter.taskMode = mode;
                this.applyFilters();
                this.buildTaskButtons();
            });
        }
    }

    private toggleTagDropdown() {
        if (this.tagDropdownEl) { this.closeTagDropdown(); return; }
        if (!this.toolbarEl) return;

        const canvas = getCanvas(this.app);
        if (!canvas) return;

        const tags = Object.entries(computeStats(canvas).tags).sort((a, b) => b[1] - a[1]);
        const dropdown = document.createElement('div');
        dropdown.className = 'cpm-tb-tag-dropdown';

        if (tags.length === 0) {
            dropdown.createEl('span', { cls: 'cpm-hint', text: 'No tags found.' });
        } else {
            for (const [tag, count] of tags) {
                const chip = dropdown.createEl('span', {
                    cls: 'cpm-tag-chip' + (this.filter.selectedTags.has(tag) ? ' cpm-tag-active' : ''),
                });
                chip.createEl('span', { cls: 'cpm-tag-name', text: tag });
                chip.createEl('span', { cls: 'cpm-tag-chip-count', text: String(count) });
                chip.addEventListener('click', e => {
                    e.stopPropagation();
                    if (this.filter.selectedTags.has(tag)) {
                        this.filter.selectedTags.delete(tag);
                        chip.removeClass('cpm-tag-active');
                    } else {
                        this.filter.selectedTags.add(tag);
                        chip.addClass('cpm-tag-active');
                    }
                    this.updateTagsBtnText();
                    this.applyFilters();
                });
            }
        }

        this.tagDropdownEl = dropdown;
        this.toolbarEl.appendChild(dropdown);

        window.setTimeout(() => {
            const handler = (e: MouseEvent) => {
                if (this.toolbarEl && !this.toolbarEl.contains(e.target as Node)) {
                    this.closeTagDropdown();
                    document.removeEventListener('mousedown', handler);
                }
            };
            document.addEventListener('mousedown', handler);
        }, 0);
    }

    private closeTagDropdown() {
        this.tagDropdownEl?.remove();
        this.tagDropdownEl = null;
    }

    private updateTagsBtnText() {
        if (!this.tagsBtnEl) return;
        const n = this.filter.selectedTags.size;
        this.tagsBtnEl.textContent = n > 0 ? `Tags (${n}) ▾` : 'Tags ▾';
        this.tagsBtnEl.classList.toggle('cpm-tb-active', n > 0);
    }

    private doAutoSize() {
        const canvas = getCanvas(this.app);
        if (!canvas) { new Notice('Open a .canvas file first.'); return; }
        const data     = getCanvasData(canvas);
        const nodesMap = canvas.nodes as Map<string, any>;
        const active   = data.nodes.filter(n =>
            !nodesMap.get(n.id)?.nodeEl?.classList.contains('cpm-node-dimmed')
        );
        if (!active.length) { new Notice('No active nodes to resize.'); return; }
        autoResizeNodes(canvas, active);
        new Notice(`Auto-sized ${active.length} nodes.`);
    }

    // ─── Filter logic ──────────────────────────────────────────────────────────

    private applyFilters() {
        const canvas = getCanvas(this.app);
        if (!canvas) return;

        const data     = getCanvasData(canvas);
        const nodesMap = canvas.nodes as Map<string, any>;
        const hasTag    = this.filter.selectedTags.size > 0;
        const hasTask   = this.filter.taskMode !== 'none';
        const hasSearch = this.filter.searchQuery.trim().length > 0;
        const anyActive = hasTag || hasTask || hasSearch;
        const query     = normalizeText(this.filter.searchQuery);
        const matchedIds = new Set<string>();

        for (const nodeData of data.nodes) {
            const domNode = nodesMap.get(nodeData.id);
            if (!domNode?.nodeEl) continue;

            const text = getNodeText(nodeData);
            let ok = true;

            if (ok && hasTag)
                ok = extractTags(text).some(t => this.filter.selectedTags.has(t));
            if (ok && hasTask)
                ok = this.filter.taskMode === 'unfinished' ? hasUnfinishedTask(text) : isFullyComplete(text);
            if (ok && hasSearch) {
                const haystack = normalizeText(
                    [text, nodeData.file ?? '', nodeData.url ?? '', nodeData.label ?? ''].join(' ')
                );
                ok = haystack.includes(query);
            }

            domNode.nodeEl.classList.toggle('cpm-node-dimmed', anyActive && !ok);
            domNode.nodeEl.classList.toggle('cpm-node-active', anyActive && ok);
            if (ok) matchedIds.add(nodeData.id);
        }

        if (!anyActive) {
            for (const n of nodesMap.values())
                n.nodeEl?.classList.remove('cpm-node-active');
        }

        // Persist for use after hierarchy refresh
        this.lastMatchedIds   = matchedIds;
        this.lastFilterActive = anyActive;

        this.syncHierarchyDimming();
    }

    /**
     * Sync hierarchy tree row visibility to the current filter state.
     * Called both from applyFilters and after refreshHierarchy.
     */
    private syncHierarchyDimming() {
        if (!this.hierarchyEl) return;
        const anyActive  = this.lastFilterActive;
        const matchedIds = this.lastMatchedIds;

        // 1. Dim/undim all leaf (non-group) rows
        const allRows = Array.from(
            this.hierarchyEl.querySelectorAll<HTMLElement>('.cpm-tree-node:not(.cpm-tree-group)')
        );
        for (const el of allRows) {
            const id = el.dataset['nodeId'];
            el.classList.toggle('cpm-tree-dimmed', anyActive && !!id && !matchedIds.has(id));
        }

        // 2. Smart group dimming: dim a group only if ALL its descendants are dimmed
        //    Process from deepest to shallowest so parents see updated children
        const groupWraps = Array.from(
            this.hierarchyEl.querySelectorAll<HTMLElement>('.cpm-tree-group-wrap')
        ).reverse();

        for (const gWrap of groupWraps) {
            const groupRow  = gWrap.querySelector<HTMLElement>(':scope > .cpm-tree-node');
            const childrenEl = gWrap.querySelector<HTMLElement>(':scope > .cpm-tree-children');
            if (!groupRow) continue;

            if (!anyActive) {
                groupRow.classList.remove('cpm-tree-dimmed');
                continue;
            }

            // Group is visible if any descendant row is not dimmed
            const hasVisibleDescendant = childrenEl
                ? Array.from(childrenEl.querySelectorAll('.cpm-tree-node'))
                    .some(el => !el.classList.contains('cpm-tree-dimmed'))
                : matchedIds.has(groupRow.dataset['nodeId'] ?? '');

            groupRow.classList.toggle('cpm-tree-dimmed', !hasVisibleDescendant);
        }
    }

    private reapplyFilters() {
        if (
            this.filter.selectedTags.size > 0 ||
            this.filter.taskMode !== 'none'    ||
            this.filter.searchQuery.trim() !== ''
        ) this.applyFilters();
    }
}

function normalizeText(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
