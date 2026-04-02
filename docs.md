# Canvas PM — Plugin Docs

## What it does

Project management overlay for Obsidian Canvas files.

- **Floating toolbar** injected at the top of any open `.canvas` — filter nodes by tag, task state, or text; auto-resize nodes.
- **Sidebar** (right panel) — one-line canvas stats and a collapsible hierarchy tree that mirrors the group/node containment structure. Clicking any tree row zooms the canvas to that node.
- Nodes that don't match the active filter are dimmed (opacity 0.25 + grayscale); matching nodes glow with a pulsing accent border. The hierarchy tree mirrors this state.

---

## File structure

```
src/
  main.ts          — plugin entry: registers view, ribbon icon, auto-opens on canvas focus
  canvasUtils.ts   — all canvas logic (pure functions, no DOM/UI)
  canvasPMView.ts  — sidebar ItemView + canvas toolbar injection
styles.css         — all styling
```

---

## Architecture

### Canvas access

Obsidian doesn't officially expose a canvas API, so everything uses `any`:

```ts
// Reliable pattern (activeLeaf is deprecated)
const leaf = getLeavesOfType('canvas')
             .find(l => l.view.file?.path === getActiveFile()?.path);
const canvas = (leaf.view as any).canvas;
```

Node data is read/written through:
```ts
canvas.getData()      // → { nodes: CanvasNodeData[], edges: any[] }
canvas.importData()   // preferred write method (falls back to canvas.setData())
canvas.requestSave()  // flush to disk
```

The canvas node map (`canvas.nodes: Map<id, internalNode>`) gives DOM access: `internalNode.nodeEl` is the live HTMLElement.

### Toolbar injection

The toolbar is a `position: absolute` div appended to `canvas.wrapperEl` (fallback: `canvas.canvasEl.parentElement`). It sits outside the canvas coordinate space so it doesn't scroll or zoom with the canvas.

```
canvas.wrapperEl  (position: relative implied by Obsidian)
  └─ .cpm-canvas-toolbar  (position: absolute; top: 12px; left: 50%; transform: translateX(-50%))
       └─ .cpm-tb-tag-dropdown  (position: absolute; top: 100%; left: 0; right: 0)
```

### Dimming / MutationObserver

Filters apply CSS classes to `.canvas-node` elements:
- `.cpm-node-dimmed` → opacity 0.25, grayscale
- `.cpm-node-active` → brightness + pulsing glow animation

The canvas virtualizes nodes (removes off-screen elements from DOM, re-adds on scroll/zoom). This strips our classes. Fix: a `MutationObserver` on the canvas wrapper watches for added `.canvas-node` elements and re-triggers `applyFilters()` with a 60ms debounce.

### Auto-resize algorithm (sigma-clipping)

Given a set of node widths `[w₁…wₙ]`:
1. Compute mean `μ` and std dev `σ`
2. Discard values where `|v − μ| > 1.5σ` (outliers)
3. Average the remaining "inlier" population

Width and height are clipped independently. If all nodes are similar, nothing is clipped and result ≈ mean. If there are a few giant/tiny outliers, they're excluded.

`autoResizeNodes(canvas, nodes)` applies this to a provided node list. `doAutoSize()` in the view feeds it only the non-dimmed nodes.

### Hierarchy

Built with `buildHierarchy(nodes)`: for each node, finds its *smallest enclosing group* (by area) — that group becomes its parent. Groups without an enclosing parent are roots. Result is a `TreeNode[]` tree sorted top-to-bottom, left-to-right per level.

Rendered as nested `cpm-tree-group-wrap > cpm-tree-node + cpm-tree-children` divs. Each group row has a chevron button for collapse/expand (stops click propagation so it doesn't trigger zoom).

After every refresh, `syncHierarchyDimming()` re-applies dim state from stored `lastMatchedIds` / `lastFilterActive`. Groups are dimmed only if all their descendants are dimmed (deepest-first traversal).

### Filter logic

State stored in `CanvasPMView.filter: FilterState`. Three independent axes combined with AND:

| Axis  | Logic |
|-------|-------|
| Tags  | OR — node must have at least one selected tag |
| Task  | `none` / `unfinished` (`- [ ]`) / `completed` (all tasks done) |
| Find  | plain substring, normalised whitespace, case-insensitive |

Applied to canvas DOM via `classList.toggle('cpm-node-dimmed', ...)`. No nodes are hidden; non-matching ones are just visually suppressed.

---

## Known fragile points

| Area | Risk |
|------|------|
| `canvas.importData` vs `canvas.setData` | Method name differs across Obsidian versions; both are attempted |
| `.canvas-node` CSS class | Internal Obsidian class — could be renamed in a future release |
| `canvas.wrapperEl` | Internal property; falls back to `canvasEl.parentElement` |
| Canvas virtualisation | MutationObserver handles most cases; edge cases may still lose classes briefly |
| `canvas.zoomToBbox` | Internal method; no official API |
| Multiple canvas tabs | Toolbar follows active canvas; stale dimming on background tabs is cleared on switch |

---

## Session decisions log

- **No hide, only dim** — hiding nodes was too disruptive; dimming keeps spatial context
- **Include-only tag filter** (OR within tags, not exclude) — simpler mental model
- **Sigma-clip as "auto"** — more useful than median because it adapts to the actual distribution of sizes; median is still available as a mode in `previewAllModes`
- **Toolbar in canvas DOM, not sidebar** — makes filters feel attached to the canvas, not a separate tool
- **Hierarchy = containment, not edges** — canvas edges are connections, not hierarchy; hierarchy is derived from which group geometrically contains a node
- **Groups dim smart** — a group stays visible if any descendant matches; dimmed only when fully irrelevant
- **MutationObserver over interval polling** — only reacts to actual DOM changes (canvas virtualization), not on a timer

---

## Todo

### Correctness / bugs
- [ ] Test toolbar injection when canvas is in a split pane vs full width
- [ ] Toolbar dropdown `left:0; right:0` assumes toolbar is narrower than viewport — test on narrow screens
- [ ] Glow animation (`cpm-node-active`) may conflict with Obsidian's own selection highlight

### Features
- [ ] File node tag extraction — currently only text node `#tags` are counted; file nodes need frontmatter parsing
- [ ] Persist filter state per canvas (save to plugin data keyed by file path)
- [ ] Undo support for auto-resize (canvas has no undo API; could snapshot and restore via `importData`)
- [ ] Keyboard shortcuts for toolbar actions (filter toggle, zoom-to-selected, etc.)
- [ ] Search highlight — bold/underline the matched substring in hierarchy node names
- [ ] Toolbar position config — let user pin toolbar to bottom or a corner
- [ ] Word count excludes markdown syntax (currently counts `#`, `**`, `-`, etc. as words)
- [ ] Hierarchy: auto-expand the group containing the currently selected canvas node
- [ ] Click hierarchy group header → select all nodes in that group on canvas

### Polish
- [ ] Hierarchy scroll position preserved across refreshes
- [ ] Collapse-all state persisted per canvas (feels odd to reset every refresh)
- [ ] Task count in toolbar (`Unfinished 3`) should update when canvas changes without requiring manual refresh
- [ ] Info line selection count requires manual refresh (5s interval) — could use canvas selection-change event if exposed
