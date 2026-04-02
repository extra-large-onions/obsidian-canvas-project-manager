import { Plugin, WorkspaceLeaf } from 'obsidian';
import { CanvasPMView, VIEW_TYPE_CANVAS_PM } from './canvasPMView';

export default class CanvasPMPlugin extends Plugin {
    async onload() {
        this.registerView(VIEW_TYPE_CANVAS_PM, leaf => new CanvasPMView(leaf));

        this.addRibbonIcon('layout-dashboard', 'Canvas PM', () => this.activateView());

        this.addCommand({
            id: 'open-canvas-pm-sidebar',
            name: 'Open Canvas PM sidebar',
            callback: () => this.activateView(),
        });

        // file-open fires after the view is fully ready, unlike active-leaf-change
        this.registerEvent(
            this.app.workspace.on('file-open', file => {
                if (file?.extension === 'canvas') {
                    this.activateView();
                }
            })
        );
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_CANVAS_PM);
    }

    async activateView() {
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(VIEW_TYPE_CANVAS_PM);

        if (existing.length > 0 && existing[0]) {
            workspace.revealLeaf(existing[0]);
            return;
        }

        const leaf: WorkspaceLeaf | null = workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({ type: VIEW_TYPE_CANVAS_PM, active: true });
            workspace.revealLeaf(leaf);
        }
    }
}
