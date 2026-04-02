import { App } from 'obsidian';

export interface CanvasNodeData {
    id: string;
    type: 'text' | 'file' | 'link' | 'group';
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
    file?: string;
    url?: string;
    color?: string;
    label?: string;
}

export interface CanvasData {
    nodes: CanvasNodeData[];
    edges: any[];
}

// ─── Canvas access ────────────────────────────────────────────────────────────

export function getCanvas(app: App): any | null {
    const activeFile = app.workspace.getActiveFile();
    const canvasLeaves = app.workspace.getLeavesOfType('canvas');
    if (canvasLeaves.length === 0) return null;

    const leaf = activeFile
        ? (canvasLeaves.find(l => (l.view as any).file?.path === activeFile.path) ?? canvasLeaves[0])
        : canvasLeaves[0];

    return (leaf?.view as any)?.canvas ?? null;
}

export function getCanvasData(canvas: any): CanvasData {
    return (canvas.getData?.() ?? { nodes: [], edges: [] }) as CanvasData;
}

export function saveCanvasData(canvas: any, data: CanvasData): void {
    if (typeof canvas.importData === 'function') {
        canvas.importData(data);
    } else if (typeof canvas.setData === 'function') {
        canvas.setData(data);
    }
    canvas.requestSave?.();
}

export function getSelectedNodes(canvas: any): CanvasNodeData[] {
    const selection: Set<any> = canvas.selection;
    if (!selection || selection.size === 0) return [];
    const allData = getCanvasData(canvas);
    const selectedIds = new Set(Array.from(selection).map((n: any) => n.id));
    return allData.nodes.filter(n => selectedIds.has(n.id));
}

export function getWorkingNodes(canvas: any): CanvasNodeData[] {
    const sel = getSelectedNodes(canvas);
    return sel.length > 0 ? sel : getCanvasData(canvas).nodes;
}

export function applyNodeChanges(canvas: any, changes: Partial<CanvasNodeData>[]): void {
    const data = getCanvasData(canvas);
    const changeMap = new Map(changes.map(c => [c.id!, c]));
    data.nodes = data.nodes.map(node => {
        const change = changeMap.get(node.id);
        return change ? { ...node, ...change } : node;
    });
    saveCanvasData(canvas, data);
}

// ─── Resize ───────────────────────────────────────────────────────────────────

export type ResizeMode = 'smallest' | 'largest' | 'average' | 'median' | 'auto';
export type ResizeAxis = 'both' | 'width' | 'height';

export interface TargetSize {
    width: number;
    height: number;
    /** Human-readable description of why auto chose this size. */
    autoReason?: string;
}

export type ResizePreview = Record<ResizeMode, TargetSize>;

/**
 * Compute the target size for every mode given a set of nodes.
 * Groups are excluded from the sample but will still be resized if present.
 */
export function previewAllModes(nodes: CanvasNodeData[]): ResizePreview | null {
    // Sample from non-group nodes so groups don't skew the numbers
    const sample = nodes.filter(n => n.type !== 'group');
    if (sample.length === 0) return null;

    const ws = sample.map(n => n.width);
    const hs = sample.map(n => n.height);

    return {
        smallest: { width: Math.min(...ws),           height: Math.min(...hs) },
        largest:  { width: Math.max(...ws),            height: Math.max(...hs) },
        average:  { width: arithmeticMean(ws),         height: arithmeticMean(hs) },
        median:   { width: median(ws),                 height: median(hs) },
        auto:     sigmaClip(ws, hs),
    };
}

export function resizeNodes(canvas: any, mode: ResizeMode, axis: ResizeAxis): void {
    const nodes = getWorkingNodes(canvas);
    const preview = previewAllModes(nodes);
    if (!preview) return;

    const target = preview[mode];
    const changes = nodes.map(n => {
        const change: Partial<CanvasNodeData> = { id: n.id };
        if (axis === 'width'  || axis === 'both') change.width  = target.width;
        if (axis === 'height' || axis === 'both') change.height = target.height;
        return change;
    });

    applyNodeChanges(canvas, changes);
}

// ─── Size algorithms ──────────────────────────────────────────────────────────

function arithmeticMean(values: number[]): number {
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1
        ? s[mid]!
        : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function stdDev(values: number[], mean: number): number {
    return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

/**
 * Auto algorithm: sigma-clipping (1.5σ).
 *
 * Computes the mean and standard deviation of widths (and heights) separately,
 * then discards any values more than 1.5σ away from the mean — these are
 * "outlier" nodes that are unusually large or small. The final target is the
 * mean of whatever remains (the "inlier population").
 *
 * Why this works well for canvas cards:
 * - If all cards are already similar in size, σ is small and nothing is
 *   discarded — result ≈ arithmetic mean (minimal disruption).
 * - If a few cards are dramatically larger/smaller (e.g. a big summary card
 *   among many small task cards), they get clipped out and the result reflects
 *   the size of the majority group.
 * - Width and height are treated independently, so a set of tall-narrow cards
 *   and wide-short cards won't be forced into a bad compromise square.
 */
function sigmaClip(ws: number[], hs: number[]): TargetSize {
    const clipAxis = (values: number[]): { result: number; clipped: number } => {
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const sd   = stdDev(values, mean);
        const threshold = 1.5 * sd;
        const inliers = sd > 0 ? values.filter(v => Math.abs(v - mean) <= threshold) : values;
        const used = inliers.length > 0 ? inliers : values;
        return {
            result:  Math.round(used.reduce((a, b) => a + b, 0) / used.length),
            clipped: values.length - used.length,
        };
    };

    const { result: width,  clipped: wc } = clipAxis(ws);
    const { result: height, clipped: hc } = clipAxis(hs);

    const totalClipped = wc + hc;
    const autoReason = totalClipped === 0
        ? 'Sizes are already uniform — using mean.'
        : `Excluded ${totalClipped} outlier value(s); averaged the rest.`;

    return { width, height, autoReason };
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

export function getNodeText(node: CanvasNodeData): string {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'group') return node.label ?? '';
    return '';
}

export function extractTags(text: string): string[] {
    return (text.match(/#[\w/-]+/g) ?? []).map(t => t.toLowerCase());
}

export function hasUnfinishedTask(text: string): boolean {
    return /- \[ \]/m.test(text);
}

export function hasAnyTask(text: string): boolean {
    return /- \[[ x]\]/im.test(text);
}

export function isFullyComplete(text: string): boolean {
    return hasAnyTask(text) && !hasUnfinishedTask(text);
}

// ─── Hierarchy ────────────────────────────────────────────────────────────────

export interface TreeNode {
    node: CanvasNodeData;
    children: TreeNode[];
    depth: number;
}

/** True if `inner` is fully contained within `outer` (with 1px tolerance). */
function containedIn(outer: CanvasNodeData, inner: CanvasNodeData): boolean {
    if (outer.id === inner.id) return false;
    return inner.x           >= outer.x - 1 &&
           inner.y           >= outer.y - 1 &&
           inner.x + inner.width  <= outer.x + outer.width  + 1 &&
           inner.y + inner.height <= outer.y + outer.height + 1;
}

/**
 * Build a containment tree from canvas nodes.
 * Each node's parent is its smallest enclosing group.
 * Nodes are sorted top-to-bottom, then left-to-right at each level.
 */
export function buildHierarchy(nodes: CanvasNodeData[]): TreeNode[] {
    const groups = nodes.filter(n => n.type === 'group');

    function directParentId(node: CanvasNodeData): string | null {
        const containers = groups.filter(g => containedIn(g, node));
        if (containers.length === 0) return null;
        // Smallest area = most specific enclosing group
        return containers.sort((a, b) => (a.width * a.height) - (b.width * b.height))[0]!.id;
    }

    const childrenMap = new Map<string | null, CanvasNodeData[]>();
    childrenMap.set(null, []);
    for (const node of nodes) {
        const pid = directParentId(node);
        if (!childrenMap.has(pid)) childrenMap.set(pid, []);
        childrenMap.get(pid)!.push(node);
    }

    // Sort each level top-to-bottom, left-to-right
    for (const children of childrenMap.values()) {
        children.sort((a, b) => a.y - b.y || a.x - b.x);
    }

    function buildSubtree(parentId: string | null, depth: number): TreeNode[] {
        return (childrenMap.get(parentId) ?? []).map(node => ({
            node,
            children: buildSubtree(node.id, depth + 1),
            depth,
        }));
    }

    return buildSubtree(null, 0);
}

/** Count all descendants of a tree node (not including the node itself). */
export function countDescendants(t: TreeNode): number {
    return t.children.reduce((n, c) => n + 1 + countDescendants(c), 0);
}

/** Extract a display name from a node: heading text, filename, or first line. */
export function getNodeDisplayName(node: CanvasNodeData): string {
    if (node.type === 'group') return node.label || '(unnamed group)';
    if (node.type === 'file')  return (node.file ?? '').split('/').pop()?.replace(/\.md$/, '') ?? '(file)';
    if (node.type === 'link') {
        try { return new URL(node.url ?? '').hostname; } catch { return node.url ?? '(link)'; }
    }
    // Text node: prefer H1 or H2 on the first line
    const text = (node.text ?? '').trimStart();
    const heading = text.match(/^#{1,2} (.+)/);
    if (heading) return heading[1]!.trim().slice(0, 60);
    const firstLine = text.split('\n').find(l => l.trim()) ?? '';
    return firstLine.slice(0, 60) || '(empty)';
}

/** Auto-resize a specific list of nodes (always uses the 'auto' sigma-clip algorithm). */
export function autoResizeNodes(canvas: any, nodes: CanvasNodeData[]): void {
    const preview = previewAllModes(nodes);
    if (!preview) return;
    const { width, height } = preview.auto;
    applyNodeChanges(canvas, nodes.map(n => ({ id: n.id, width, height })));
}

/** Total word count across all text/group nodes. */
export function countWords(canvas: any): number {
    return getCanvasData(canvas).nodes.reduce((total, node) => {
        const text = getNodeText(node).trim();
        if (!text) return total;
        return total + text.split(/\s+/).length;
    }, 0);
}

/** Return all nodes that contain at least one unfinished task checkbox. */
export function getUnfinishedTaskNodes(canvas: any): CanvasNodeData[] {
    return getCanvasData(canvas).nodes.filter(n => hasUnfinishedTask(getNodeText(n)));
}

/**
 * Zoom the canvas so the given node occupies 50–80% of the viewport.
 * Bigger nodes (larger max dimension) fill more of the screen.
 *
 * fill % = lerp(50%, 80%, clamp((maxDim - 200) / 400, 0, 1))
 * Padding is derived from the fill target so zoomToBbox lands exactly right.
 */
export function zoomToNode(canvas: any, node: CanvasNodeData): void {
    const maxDim = Math.max(node.width, node.height);
    const t      = Math.max(0, Math.min(1, (maxDim - 200) / 400));
    const fill   = 0.5 + t * 0.3;                       // 0.50 → 0.80

    // How much extra space to add so the node fills `fill` of the viewport bbox
    const padX = node.width  * (1 / fill - 1) / 2;
    const padY = node.height * (1 / fill - 1) / 2;
    const pad  = Math.max(padX, padY);                   // uniform padding

    canvas.zoomToBbox?.({
        minX: node.x - pad,
        minY: node.y - pad,
        maxX: node.x + node.width  + pad,
        maxY: node.y + node.height + pad,
    });
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface CanvasStats {
    total: number;
    byType: Record<string, number>;
    byColor: Record<string, number>;
    tasks: { total: number; done: number; undone: number };
    tags: Record<string, number>;
}

export function computeStats(canvas: any): CanvasStats {
    const data = getCanvasData(canvas);
    const stats: CanvasStats = {
        total: data.nodes.length,
        byType: {},
        byColor: {},
        tasks: { total: 0, done: 0, undone: 0 },
        tags: {},
    };

    for (const node of data.nodes) {
        stats.byType[node.type] = (stats.byType[node.type] ?? 0) + 1;
        stats.byColor[node.color ?? 'default'] = (stats.byColor[node.color ?? 'default'] ?? 0) + 1;

        const text = getNodeText(node);
        const undone = (text.match(/- \[ \]/g) ?? []).length;
        const done   = (text.match(/- \[x\]/gi) ?? []).length;
        stats.tasks.undone += undone;
        stats.tasks.done   += done;
        stats.tasks.total  += undone + done;

        for (const tag of extractTags(text)) {
            stats.tags[tag] = (stats.tags[tag] ?? 0) + 1;
        }
    }

    return stats;
}
