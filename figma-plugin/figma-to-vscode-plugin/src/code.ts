// code.ts
//
// Figma plugin main runtime — MVP 1–5.
//
// Responsibilities:
//   - Extract a raw node tree from the current selection.
//   - Resolve INSTANCE nodes against a persisted Component Mapping registry
//     and the FE component catalog received from VS Code.
//   - Prune matched component subtrees ("Match + Prune").
//   - Extract design tokens (local variables + bound variables on nodes +
//     local color/text/effect styles) and match against the FE token catalog
//     received from VS Code.
//   - Export marked icon/image/vector assets to bytes.
//   - Produce a CompressedSpec that the UI can ship to VS Code.
//
// Persistence:
//   - Component mappings + FE catalogs live in figma.clientStorage (per user).
//   - Per-node asset marks live in node.setPluginData("vscode-mark", ...).

import {
  AssetMark,
  AssetRef,
  AssetRefSpec,
  AutofillSuggestion,
  ComponentContent,
  ComponentContentText,
  ComponentMapping,
  ComponentRefSpec,
  CompressedSpec,
  LeanContent,
  DesignTokenRef,
  FEComponentCatalogItem,
  FETokenCatalogItem,
  LayoutSpec,
  LeanAsset,
  LeanComponent,
  LeanLayout,
  LeanNode,
  LeanSpec,
  LeanText,
  MainToUi,
  MappingReport,
  PLUGIN_VERSION,
  ReviewComponent,
  SelectionTreeNode,
  SpecNode,
  TextSpec,
  TokenKind,
  UiToMain,
} from "./types";
import { buildNwaBundle } from "./nwa";

const ALLOWED_SELECTION_TYPES: ReadonlyArray<NodeType> = [
  "FRAME",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
  "SECTION",
  "GROUP",
];

const STORAGE_KEY_MAPPINGS = "vscode-bridge:mappings";
const STORAGE_KEY_COMPONENT_CATALOG = "vscode-bridge:catalog:components";
const STORAGE_KEY_TOKEN_CATALOG = "vscode-bridge:catalog:tokens";
const PLUGIN_DATA_MARK = "vscode-mark";
// Persistent tags written onto Figma nodes when a mapping is confirmed.
// These survive across file copies / re-renders / new layouts and let
// Auto-fill restore the mapping at P0 (highest priority) without rerunning
// the catalog matcher. The figmaComponentKey on the main component is the
// other half of the stickiness; this tag is the "anything-with-this-id"
// fallback for non-main nodes (frames, groups, sections used as components).
const PLUGIN_DATA_MAPPING_ID = "vscode-mapping-id";
const PLUGIN_DATA_CODE_COMPONENT = "vscode-code-component";
const UI_SIZE = { width: 700, height: 720 } as const;

// The plugin runs in two contexts:
//   - Figma Design (figma.mode === "default"): we show the full iframe UI
//     immediately so the user gets all five tabs + Component Records Manager.
//   - Dev Mode (figma.mode === "codegen"): Figma forbids calling
//     figma.showUI() on plugin load. We register a codegen handler that
//     puts a small "Open plugin window" hint + propertyMenu in the right
//     inspect panel. Clicking it fires "preferenceschanged" and THEN we can
//     legally call figma.showUI() to open the full iframe.
const IS_CODEGEN = figma.mode === "codegen";

if (!IS_CODEGEN) {
  figma.showUI(__html__, { ...UI_SIZE, themeColors: true });
} else {
  registerCodegenLauncher();
}

function post(msg: MainToUi): void {
  // In Dev Mode the UI iframe may not be open yet; guard so postMessage
  // doesn't throw before the user clicks "Open plugin window".
  try {
    figma.ui.postMessage(msg);
  } catch {
    /* iframe not open yet — ignore */
  }
}

function registerCodegenLauncher(): void {
  const codegen = (figma as unknown as {
    codegen?: {
      on: (
        event: "generate" | "preferenceschange",
        cb: (e: never) => unknown
      ) => void;
    };
  }).codegen;
  if (!codegen) return;

  // Render a hint snippet in the inspect panel. The "Open plugin window"
  // action is declared in manifest.codegenPreferences and surfaces as the
  // panel's settings (gear/···) menu.
  codegen.on(
    "generate",
    (() => {
      return [
        {
          title: "Figma to VS Code Sender",
          code:
            "// Open the inspect panel's settings menu and pick\n" +
            "// 'Open plugin window' to launch the full UI:\n" +
            "//   - Connection / handshake with VS Code\n" +
            "//   - Export / Build nwa bundle / Send / Download\n" +
            "//   - Tokens, Assets, Report\n" +
            "//   - Settings -> Component Records Manager",
          language: "PLAINTEXT",
        },
      ];
    }) as never
  );

  // preferenceschange fires when the user clicks an action declared in
  // manifest.codegenPreferences. We use it as the user-initiated trigger
  // that finally lets us call figma.showUI() in Dev Mode.
  codegen.on(
    "preferenceschange",
    ((event: { propertyName: string }) => {
      if (event.propertyName === "open-plugin") {
        try {
          figma.showUI(__html__, { ...UI_SIZE, themeColors: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          figma.notify(`Failed to open plugin window: ${message}`, {
            error: true,
          });
        }
      }
    }) as never
  );
}

// ---------------------------------------------------------------------------
// Selection state
// ---------------------------------------------------------------------------

function getSelectionState(): {
  hasValidSelection: boolean;
  selection: { id: string; name: string; type: string } | null;
} {
  const node = figma.currentPage.selection[0];
  const isValid =
    !!node && (ALLOWED_SELECTION_TYPES as ReadonlyArray<string>).includes(node.type);
  return {
    hasValidSelection: isValid,
    selection: node ? { id: node.id, name: node.name, type: node.type } : null,
  };
}

// Plugin-driven selection state for the "highlight flash" (eye icon).
//
// Conceptually we want two independent things:
//   • User selection — what the designer has clicked on the Figma canvas.
//     This is the *only* signal that should rebuild the plugin's Selection
//     tree.
//   • Tree-row focus — clicking the eye icon in a tree row paints Figma's
//     purple selection border on the target node so the user can spot it,
//     but it must NOT propagate back into the tree or the selection card.
//
// Figma's plugin API exposes a single global selection (figma.currentPage.
// selection) and fires selectionchange on every write — including the
// programmatic writes we use to render the flash. So we suppress those
// programmatic events explicitly: a flag is raised before the flash, every
// selectionchange that fires while the flag is up is swallowed, and the
// flag drops one microtask after the restore.
let flashing = false;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let flashRealSelection: SceneNode[] = [];

figma.on("selectionchange", () => {
  if (flashing) {
    // The flash and its restore write both produce selectionchange events;
    // both belong to the plugin, not the user, so we drop them on the
    // floor. The Selection tree stays anchored to the user's real
    // selection from before the flash began.
    return;
  }
  const s = getSelectionState();
  post({ type: "SELECTION_STATE", ...s });
});

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function loadMappings(): Promise<ComponentMapping[]> {
  try {
    const raw = await figma.clientStorage.getAsync(STORAGE_KEY_MAPPINGS);
    return Array.isArray(raw) ? (raw as ComponentMapping[]) : [];
  } catch {
    return [];
  }
}

async function saveMappings(list: ComponentMapping[]): Promise<void> {
  await figma.clientStorage.setAsync(STORAGE_KEY_MAPPINGS, list);
}

async function loadComponentCatalog(): Promise<FEComponentCatalogItem[]> {
  try {
    const raw = await figma.clientStorage.getAsync(STORAGE_KEY_COMPONENT_CATALOG);
    return Array.isArray(raw) ? (raw as FEComponentCatalogItem[]) : [];
  } catch {
    return [];
  }
}

async function loadTokenCatalog(): Promise<FETokenCatalogItem[]> {
  try {
    const raw = await figma.clientStorage.getAsync(STORAGE_KEY_TOKEN_CATALOG);
    return Array.isArray(raw) ? (raw as FETokenCatalogItem[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

figma.ui.onmessage = async (msg: UiToMain) => {
  await handleUiMessage(msg);
};

async function handleUiMessage(msg: UiToMain): Promise<void> {
  try {
    switch (msg.type) {
      case "INIT": {
        const [mappings, components, tokens] = await Promise.all([
          loadMappings(),
          loadComponentCatalog(),
          loadTokenCatalog(),
        ]);
        const s = getSelectionState();
        post({
          type: "INITIAL_STATE",
          mappings,
          ...s,
          catalogs: { components, tokens },
        });
        return;
      }

      case "GET_MAPPINGS": {
        const mappings = await loadMappings();
        post({ type: "MAPPINGS_UPDATED", mappings });
        return;
      }

      case "SAVE_MAPPING": {
        const list = await loadMappings();
        const idx = list.findIndex((m) => m.id === msg.mapping.id);
        const stamped: ComponentMapping = {
          ...msg.mapping,
          updatedAt: new Date().toISOString(),
        };
        if (idx >= 0) list[idx] = stamped;
        else list.push(stamped);
        await saveMappings(list);
        // Tag the node itself so the mapping is sticky across files and
        // future layouts that reuse this exact node instance.
        if (stamped.figmaNodeId) {
          try {
            const node = await figma.getNodeByIdAsync(stamped.figmaNodeId);
            if (node && "setPluginData" in node) {
              (node as BaseNode).setPluginData(PLUGIN_DATA_MAPPING_ID, stamped.id);
              (node as BaseNode).setPluginData(
                PLUGIN_DATA_CODE_COMPONENT,
                stamped.codeComponent
              );
            }
          } catch {
            /* node may have been removed; tag was best-effort */
          }
        }
        post({ type: "MAPPINGS_UPDATED", mappings: list });
        return;
      }

      case "DELETE_MAPPING": {
        const list = await loadMappings();
        const removed = list.find((m) => m.id === msg.id);
        const next = list.filter((m) => m.id !== msg.id);
        await saveMappings(next);
        // Clear the sticky tag on the original node so the matcher won't keep
        // pointing at a mapping that no longer exists.
        if (removed?.figmaNodeId) {
          try {
            const node = await figma.getNodeByIdAsync(removed.figmaNodeId);
            if (node && "setPluginData" in node) {
              (node as BaseNode).setPluginData(PLUGIN_DATA_MAPPING_ID, "");
              (node as BaseNode).setPluginData(PLUGIN_DATA_CODE_COMPONENT, "");
            }
          } catch {
            /* node already gone */
          }
        }
        post({ type: "MAPPINGS_UPDATED", mappings: next });
        return;
      }

      case "SET_CATALOGS": {
        if (msg.components) {
          await figma.clientStorage.setAsync(
            STORAGE_KEY_COMPONENT_CATALOG,
            msg.components
          );
        }
        if (msg.tokens) {
          await figma.clientStorage.setAsync(
            STORAGE_KEY_TOKEN_CATALOG,
            msg.tokens
          );
        }
        return;
      }

      case "SCAN_SELECTION": {
        const node = requireSelectedNode();
        post({ type: "PROGRESS", stage: "Scanning node tree…" });
        const summary = await summariseSelection(node);
        post({ type: "SCAN_RESULT", summary });
        return;
      }

      case "AUTOFILL_MAPPINGS": {
        const node = requireSelectedNode();
        const [mappings, components] = await Promise.all([
          loadMappings(),
          loadComponentCatalog(),
        ]);
        post({ type: "PROGRESS", stage: "Resolving INSTANCE nodes…" });
        const suggestions = await autofillSuggestions(node, mappings, components);
        post({ type: "AUTOFILL_RESULT", suggestions });
        return;
      }

      case "BUILD_SPEC": {
        const node = requireSelectedNode();
        const [mappings, components, tokens] = await Promise.all([
          loadMappings(),
          loadComponentCatalog(),
          loadTokenCatalog(),
        ]);
        post({ type: "PROGRESS", stage: "Building compressed spec…" });
        const spec = await buildCompressedSpec(node, mappings, components, tokens);
        const lean = buildLeanSpec(spec);
        post({ type: "PROGRESS", stage: "Building nwa export bundle…" });
        const nwa = await buildNwaBundle(node, mappings);
        post({ type: "SPEC_READY", spec, lean, nwa });
        return;
      }

      case "SET_NODE_MARK": {
        const n = await figma.getNodeByIdAsync(msg.nodeId);
        if (n && "setPluginData" in n) {
          (n as BaseNode).setPluginData(PLUGIN_DATA_MARK, msg.mark ?? "");
        }
        return;
      }

      case "ZOOM_TO_NODE": {
        const n = await figma.getNodeByIdAsync(msg.nodeId);
        if (n && n.type !== "DOCUMENT" && n.type !== "PAGE") {
          figma.viewport.scrollAndZoomIntoView([n as SceneNode]);
          if (msg.highlight) {
            // "Highlight" mode (eye icon) — combine the only two non-
            // destructive feedback signals Figma exposes:
            //   1. Snap-select the target node so Figma paints its purple
            //      selection border, then restore the user's real
            //      selection after ~2s. Plugin-driven selectionchange
            //      events are swallowed by the listener above so the
            //      Selection tree stays anchored to whatever the user
            //      chose on the canvas.
            //   2. A toast at the bottom of the canvas confirming which
            //      node we focused on — useful when the node is small or
            //      offscreen during the zoom animation.
            const sceneNode = n as SceneNode;

            // Cancel any in-flight restore so overlapping eye clicks share
            // one continuous flash window rather than fighting each other.
            if (flashTimer !== null) {
              clearTimeout(flashTimer);
              flashTimer = null;
            }

            // Capture the user's *real* selection only at the start of a
            // fresh flash. A second eye click during the same window
            // should still restore the original user selection, not the
            // previous flash target.
            if (!flashing) {
              flashRealSelection = figma.currentPage.selection.slice();
              flashing = true;
            }

            figma.currentPage.selection = [sceneNode];
            figma.notify(`Focused on “${sceneNode.name || "node"}”`, {
              timeout: 2000,
            });

            flashTimer = setTimeout(() => {
              try {
                const stillValid = flashRealSelection.filter(
                  (s) => s.parent !== null
                );
                // Still inside the flashing window — the restore write
                // fires one more selectionchange that we want to swallow
                // before dropping the suppression flag.
                figma.currentPage.selection = stillValid;
              } catch {
                /* page may have changed; ignore */
              }
              // Drop the flag on the next tick so Figma's selectionchange
              // event from the restore has fired and been swallowed.
              setTimeout(() => {
                flashing = false;
                flashRealSelection = [];
                flashTimer = null;
              }, 50);
            }, 2000);
          } else if (!msg.preserveSelection) {
            figma.currentPage.selection = [n as SceneNode];
          }
        }
        return;
      }

      case "ZOOM_TO_SELECTION": {
        const sel = figma.currentPage.selection;
        if (sel.length > 0) figma.viewport.scrollAndZoomIntoView(sel);
        return;
      }

      case "GET_FIGMA_COMPONENTS": {
        const names = await collectFigmaComponentNames();
        post({ type: "FIGMA_COMPONENTS", names });
        return;
      }

      case "EXPAND_SELECTION": {
        const sel = figma.currentPage.selection;
        if (sel.length === 0) return;
        const all: SceneNode[] = [];
        const seen = new Set<string>();
        for (const r of sel) collectVisibleDescendants(r, all, seen);
        if (all.length === 0) return;
        figma.currentPage.selection = all;
        figma.notify(
          `Expanded selection to ${all.length} node${all.length === 1 ? "" : "s"}.`
        );
        return;
      }

      case "CLOSE_PLUGIN":
        figma.closePlugin();
        return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: "ERROR", error: message });
    figma.notify(message, { error: true });
  }
}

// ---------------------------------------------------------------------------
// Selection helper
// ---------------------------------------------------------------------------

function requireSelectedNode(): SceneNode {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) {
    throw new Error(
      "Nothing is selected. Pick a frame, component, instance, section, or group."
    );
  }
  const node = sel[0];
  if (!ALLOWED_SELECTION_TYPES.includes(node.type)) {
    throw new Error(
      `Selected node type "${node.type}" is not supported. ` +
        `Supported: ${ALLOWED_SELECTION_TYPES.join(", ")}.`
    );
  }
  return node;
}

// ---------------------------------------------------------------------------
// Selection summary (for the Export tab "Scan" button)
// ---------------------------------------------------------------------------

async function summariseSelection(root: SceneNode): Promise<{
  nodes: number;
  instances: number;
  textNodes: number;
  tree: SelectionTreeNode | null;
  reviewComponents: ReviewComponent[];
  tokens: DesignTokenRef[];
  unmatchedInstances: Array<{
    nodeId: string;
    name: string;
    figmaName: string;
    displayName: string;
    mainComponentKey?: string;
  }>;
}> {
  const mappings = await loadMappings();
  const components = await loadComponentCatalog();
  // Token extraction now runs as part of "scan selection" so the Tokens tab
  // refreshes immediately, without waiting for a full Build.
  const tokenCatalog = await loadTokenCatalog();
  const localVars = await loadLocalVariables();
  const tokens = new Map<string, DesignTokenRef>();

  let nodes = 0;
  let instances = 0;
  let textNodes = 0;
  // Track unmatched instances by their stable component identity
  // (figmaComponentKey when available, else figmaName), so that a screen with
  // 30 copies of the same Button only adds one row to the unmatched list.
  const unmatched: Array<{
    nodeId: string;
    name: string;
    figmaName: string;
    displayName: string;
    mainComponentKey?: string;
  }> = [];
  const unmatchedSeen = new Set<string>();

  // Unique component rows for the Review & Export table.
  const reviewComponents: ReviewComponent[] = [];
  const reviewSeen = new Set<string>();

  // Recursive tree build + data collection in one pass.
  async function buildTree(n: SceneNode): Promise<SelectionTreeNode> {
    nodes++;
    if (n.type === "TEXT") textNodes++;

    // Collect design tokens (bound variables + text styles) for this node.
    await collectNodeTokens(n, tokens, tokenCatalog, localVars);

    let matched = false;
    let mappingName = n.name;
    let figmaComponentKey: string | undefined;
    let figmaComponentName: string | undefined;
    let codeComponent: string | undefined;
    let codeFilePath: string | undefined;
    let importType: "default" | "named" | undefined;
    let importName: string | undefined;

    if (n.type === "INSTANCE") {
      instances++;
      const mc = await tryGetMain(n as InstanceNode);
      const figmaName = mc?.name ?? n.name;
      mappingName = figmaName;
      figmaComponentKey = mc?.key;
      figmaComponentName = mc?.name;
      const sticky = readStickyMappingId(n);
      const m = matchMapping(
        {
          figmaName,
          figmaComponentKey: mc?.key,
          figmaNodeId: n.id,
          stickyMappingId: sticky,
        },
        mappings,
        components
      );
      // Only count as "matched" when the match comes from a user-saved
      // mapping (P0–P4). The matcher's P5 priority returns a *synthetic*
      // mapping built from the FE component catalog (id starts with
      // "auto:") — it's a suggestion, not a confirmed mapping, so the tree
      // star and side-panel info should treat it as unmatched until the
      // user confirms it via Auto-Fill or the record manager.
      const savedMatch = isSavedMatch(m);
      matched = savedMatch;
      codeComponent = savedMatch ? m!.mapping.codeComponent : undefined;
      codeFilePath = savedMatch ? m!.mapping.codeFilePath : undefined;
      importType = savedMatch ? m!.mapping.importType : undefined;
      importName = savedMatch ? m!.mapping.importName : undefined;
      if (!savedMatch) {
        // Dedupe by component identity — the same Figma component class can
        // appear dozens of times in a screen, but the user only needs to map
        // it once. Catalog suggestions also land here so the user gets a
        // chance to confirm them.
        const dedupeKey = mc?.key ?? figmaName;
        if (!unmatchedSeen.has(dedupeKey)) {
          unmatchedSeen.add(dedupeKey);
          unmatched.push({
            nodeId: n.id,
            name: n.name,
            figmaName,
            displayName: getDisplayName(mc, n),
            mainComponentKey: mc?.key,
          });
        }
      }
      const key = mc?.key ?? figmaName;
      if (!reviewSeen.has(key)) {
        reviewSeen.add(key);
        reviewComponents.push({
          nodeId: n.id,
          name: figmaName,
          type: "INSTANCE",
          codeComponent: savedMatch ? m!.mapping.codeComponent : null,
          codeFilePath: savedMatch ? m!.mapping.codeFilePath : null,
        });
      }
    } else {
      const sticky = readStickyMappingId(n);
      const m = matchMapping(
        {
          figmaName: n.name,
          figmaNodeId: n.id,
          stickyMappingId: sticky,
        },
        mappings,
        components
      );
      // Same saved-vs-synthetic filter as the INSTANCE branch above.
      const savedMatch = isSavedMatch(m);
      matched = savedMatch;
      codeComponent = savedMatch ? m!.mapping.codeComponent : undefined;
      codeFilePath = savedMatch ? m!.mapping.codeFilePath : undefined;
      importType = savedMatch ? m!.mapping.importType : undefined;
      importName = savedMatch ? m!.mapping.importName : undefined;
    }

    const treeNode: SelectionTreeNode = {
      id: n.id,
      name: n.name,
      type: n.type,
      isInstance: n.type === "INSTANCE",
      matched,
      mappingName,
      figmaComponentKey,
      figmaComponentName,
      codeComponent,
      codeFilePath,
      importType,
      importName,
    };

    if ("children" in n) {
      const kids: SelectionTreeNode[] = [];
      for (const c of (n as ChildrenMixin).children as SceneNode[]) {
        kids.push(await buildTree(c));
      }
      if (kids.length) treeNode.children = kids;
    }
    return treeNode;
  }

  const tree = await buildTree(root);

  // The selected root is always the first row of the review table.
  let rootCode: { codeComponent: string | null; codeFilePath: string | null } = {
    codeComponent: null,
    codeFilePath: null,
  };
  if (root.type === "INSTANCE") {
    const mc = await tryGetMain(root as InstanceNode);
    const sticky = readStickyMappingId(root);
    const m = matchMapping(
      {
        figmaName: mc?.name ?? root.name,
        figmaComponentKey: mc?.key,
        figmaNodeId: root.id,
        stickyMappingId: sticky,
      },
      mappings,
      components
    );
    if (m) {
      rootCode = {
        codeComponent: m.mapping.codeComponent,
        codeFilePath: m.mapping.codeFilePath,
      };
    }
  }
  reviewComponents.unshift({
    nodeId: root.id,
    name: root.name,
    type: root.type,
    codeComponent: rootCode.codeComponent,
    codeFilePath: rootCode.codeFilePath,
  });

  return {
    nodes,
    instances,
    textNodes,
    tree,
    reviewComponents,
    tokens: Array.from(tokens.values()),
    unmatchedInstances: unmatched,
  };
}

// Collects component names that exist in the Figma file, used to power the
// "Figma Name" autocomplete in the Component Records Manager.
//
// Sources, in priority order:
//   1. The current selection subtree -- every INSTANCE node's own name, every
//      INSTANCE's resolved main component, and any COMPONENT / COMPONENT_SET
//      directly in the tree. This guarantees everything the user can see in
//      what they selected appears in the dropdown.
//   2. Every COMPONENT_SET / standalone COMPONENT in the whole document, so
//      the user can also map components that aren't in the current selection.
async function collectFigmaComponentNames(): Promise<string[]> {
  const names = new Set<string>();

  // ---- 1. Walk the current selection subtree --------------------------------
  const visit = async (n: SceneNode): Promise<void> => {
    if (n.type === "INSTANCE") {
      // The instance node's own name is what shows in the layers panel and in
      // the exported JSON (e.g. "Badge") -- always include it.
      if (n.name) names.add(n.name);
      try {
        const mc = await (n as InstanceNode).getMainComponentAsync();
        if (mc) {
          if (mc.parent && mc.parent.type === "COMPONENT_SET") {
            names.add(mc.parent.name);
          } else if (mc.name) {
            names.add(mc.name);
          }
        }
      } catch {
        /* ignore unresolvable instance */
      }
    } else if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") {
      if (n.name) names.add(n.name);
    }
    if ("children" in n) {
      for (const c of (n as ChildrenMixin).children as SceneNode[]) {
        await visit(c);
      }
    }
  };
  try {
    for (const sel of figma.currentPage.selection) {
      await visit(sel);
    }
  } catch {
    /* ignore */
  }

  // ---- 2. All components defined anywhere in the document -------------------
  try {
    const found = figma.root.findAllWithCriteria({
      types: ["COMPONENT", "COMPONENT_SET"],
    });
    for (const c of found) {
      // Skip variant children of a set -- the set name is friendlier.
      if (c.type === "COMPONENT" && c.parent && c.parent.type === "COMPONENT_SET") {
        continue;
      }
      if (c.name) names.add(c.name);
    }
  } catch {
    /* findAllWithCriteria unavailable or page not loaded — ignore */
  }

  return Array.from(names)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

// Collects design tokens used by a single node: bound variables on fills /
// strokes / corner radius, drop-shadow effects, and the node's text style.
// Mutates the shared `tokens` map (deduped by variable id / style name).
async function collectNodeTokens(
  n: SceneNode,
  tokens: Map<string, DesignTokenRef>,
  tokenCatalog: ReadonlyArray<FETokenCatalogItem>,
  localVars: Map<string, Variable>
): Promise<void> {
  const regVar = (v: Variable, type: TokenKind, rawValue: unknown): void => {
    const key = `var:${v.id}`;
    const existing = tokens.get(key);
    if (existing) {
      existing.usageCount++;
      return;
    }
    const match = matchTokenName(v.name, tokenCatalog);
    tokens.set(key, {
      figmaTokenName: v.name,
      figmaVariableId: v.id,
      type,
      value: rawValue,
      codeTokenName: match?.name,
      codeTokenPath: match?.filePath,
      confidence: match?.score,
      usageCount: 1,
    });
  };

  const anyN = n as unknown as {
    fills?: ReadonlyArray<Paint> | symbol;
    strokes?: ReadonlyArray<Paint>;
    cornerRadius?: number | symbol;
    effects?: ReadonlyArray<Effect>;
  };

  if (Array.isArray(anyN.fills)) {
    (anyN.fills as Paint[]).forEach((p, i) => {
      const ref = bindingForField(n, `fills.${i}`);
      const v = ref ? localVars.get(ref) : null;
      if (v) regVar(v, "color", p);
    });
  }
  if (Array.isArray(anyN.strokes)) {
    (anyN.strokes as Paint[]).forEach((p, i) => {
      const ref = bindingForField(n, `strokes.${i}`);
      const v = ref ? localVars.get(ref) : null;
      if (v) regVar(v, "color", p);
    });
  }
  if (typeof anyN.cornerRadius === "number") {
    const ref = bindingForField(n, "cornerRadius");
    const v = ref ? localVars.get(ref) : null;
    if (v) regVar(v, "radius", anyN.cornerRadius);
  }
  if (Array.isArray(anyN.effects)) {
    for (const e of anyN.effects as Effect[]) {
      const key = `effect:${JSON.stringify(e)}`;
      const existing = tokens.get(key);
      if (existing) {
        existing.usageCount++;
        continue;
      }
      tokens.set(key, {
        figmaTokenName: `effect/${e.type.toLowerCase()}`,
        type: "shadow",
        value: e,
        usageCount: 1,
      });
    }
  }

  if (n.type === "TEXT") {
    try {
      const sid = (n as unknown as { textStyleId?: string | symbol }).textStyleId;
      if (typeof sid === "string" && sid) {
        const style = await figma.getStyleByIdAsync(sid);
        if (style) {
          const key = `typo:${style.name}`;
          const existing = tokens.get(key);
          if (existing) {
            existing.usageCount++;
          } else {
            const match = matchTokenName(style.name, tokenCatalog);
            tokens.set(key, {
              figmaTokenName: style.name,
              figmaStyleId: sid,
              type: "typography",
              value: { name: style.name },
              codeTokenName: match?.name,
              codeTokenPath: match?.filePath,
              confidence: match?.score,
              usageCount: 1,
            });
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
}

async function walkAsync(
  n: SceneNode,
  visit: (n: SceneNode) => Promise<void> | void
): Promise<void> {
  await visit(n);
  if ("children" in n) {
    for (const c of (n as ChildrenMixin).children as SceneNode[]) {
      await walkAsync(c, visit);
    }
  }
}

async function tryGetMain(n: InstanceNode): Promise<ComponentNode | null> {
  try {
    return await n.getMainComponentAsync();
  } catch {
    return null;
  }
}

// Pick the most human-readable label for an INSTANCE node.
//
// Figma variants live inside a COMPONENT_SET. The main component's own .name
// is the variant key (e.g. "Type=Normal, Breakpoint=Desktop"); the parent
// COMPONENT_SET carries the friendly base name (e.g. "Card header"). The
// instance node's .name follows the same default, so we walk:
//   1. mc.parent.name when the main lives inside a COMPONENT_SET
//   2. else mc.name (non-variant main component)
//   3. else the layer's own name as a last resort
// "Variant=Foo" strings still survive in figmaName so the matcher's
// name-based priorities (P3 / P4) keep working — only the displayed label
// changes.
function getDisplayName(mc: ComponentNode | null, n: SceneNode): string {
  if (mc && mc.parent && mc.parent.type === "COMPONENT_SET" && mc.parent.name) {
    return mc.parent.name;
  }
  if (mc && mc.name && !/=/.test(mc.name)) {
    return mc.name;
  }
  if (n.name && !/=/.test(n.name)) {
    return n.name;
  }
  return mc?.name || n.name || "Component";
}

// ---------------------------------------------------------------------------
// Matcher — priorities P1..P5
// ---------------------------------------------------------------------------

interface MatchInput {
  figmaName: string;
  figmaNodeId?: string;
  figmaComponentKey?: string;
  // When set, the node has been previously tagged with a confirmed mapping id.
  // This takes precedence over every other priority (P0).
  stickyMappingId?: string;
}

interface MatchResult {
  mapping: ComponentMapping;
  confidence: number;
  reason: string;
}

// Distinguishes a confirmed (user-saved) match from a P5 catalog suggestion.
// P5 builds a synthetic mapping on the fly with id "auto:<componentName>";
// every saved mapping uses a different id format (manual "m_*", auto-fill
// "auto_*", project-mappings carry whatever id VS Code generated). The
// colon vs. underscore split keeps catalog suggestions out of "matched"
// state until the user explicitly confirms them.
function isSavedMatch(m: MatchResult | null): m is MatchResult {
  return !!m && !m.mapping.id.startsWith("auto:");
}

function matchMapping(
  input: MatchInput,
  mappings: ReadonlyArray<ComponentMapping>,
  components: ReadonlyArray<FEComponentCatalogItem>
): MatchResult | null {
  // P0: sticky tag written onto the node when the user confirmed a mapping
  if (input.stickyMappingId) {
    const hit = mappings.find((m) => m.id === input.stickyMappingId);
    if (hit) {
      return { mapping: hit, confidence: 1, reason: "sticky-tag" };
    }
  }

  // P1: exact figmaNodeId
  if (input.figmaNodeId) {
    const hit = mappings.find((m) => m.figmaNodeId === input.figmaNodeId);
    if (hit) {
      return { mapping: hit, confidence: hit.confidence || 1, reason: "node-id-match" };
    }
  }

  // P2: exact figmaComponentKey
  if (input.figmaComponentKey) {
    const hit = mappings.find(
      (m) => m.figmaComponentKey === input.figmaComponentKey
    );
    if (hit) {
      return { mapping: hit, confidence: hit.confidence || 1, reason: "key-match" };
    }
  }

  // P3: exact figmaName
  const exact = mappings.find((m) => m.figmaName === input.figmaName);
  if (exact) {
    return {
      mapping: exact,
      confidence: exact.confidence || 0.95,
      reason: "name-exact",
    };
  }

  // P4: normalised name match (case + separators ignored)
  const norm = normaliseName(input.figmaName);
  const normHit = mappings.find((m) => normaliseName(m.figmaName) === norm);
  if (normHit) {
    return {
      mapping: normHit,
      confidence: Math.max(0.8, normHit.confidence ?? 0),
      reason: "name-normalised",
    };
  }

  // P5: catalog-derived synthetic mapping (auto-suggested, name-based)
  const catalogHit = bestCatalogMatch(input.figmaName, components);
  if (catalogHit) {
    const synthetic: ComponentMapping = {
      id: `auto:${catalogHit.item.componentName}`,
      figmaName: input.figmaName,
      figmaComponentKey: input.figmaComponentKey,
      codeComponent: catalogHit.item.componentName,
      codeFilePath: catalogHit.item.filePath,
      importType: catalogHit.item.exportType,
      importName: catalogHit.item.componentName,
      confidence: catalogHit.score,
      source: "auto-suggested",
      updatedAt: new Date().toISOString(),
    };
    return {
      mapping: synthetic,
      confidence: catalogHit.score,
      reason: catalogHit.reason,
    };
  }

  return null;
}

function normaliseName(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function bestCatalogMatch(
  figmaName: string,
  components: ReadonlyArray<FEComponentCatalogItem>
): { item: FEComponentCatalogItem; score: number; reason: string } | null {
  if (!components.length) return null;
  const target = normaliseName(figmaName);
  let best: { item: FEComponentCatalogItem; score: number; reason: string } | null = null;
  for (const c of components) {
    const candidates = [c.componentName, ...(c.aliases ?? [])];
    for (const cand of candidates) {
      const cn = normaliseName(cand);
      if (!cn) continue;
      let score = 0;
      let reason = "";
      if (cn === target) { score = 0.9; reason = "catalog-exact"; }
      else if (target.includes(cn) || cn.includes(target)) {
        score = 0.7; reason = "catalog-substring";
      } else {
        const sim = diceCoefficient(cn, target);
        if (sim >= 0.6) { score = 0.4 + sim * 0.4; reason = `catalog-fuzzy(${sim.toFixed(2)})`; }
      }
      if (score > 0 && (!best || score > best.score)) {
        best = { item: c, score, reason };
      }
    }
  }
  return best;
}

function diceCoefficient(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of A) {
    if (B.has(bg)) intersection += Math.min(count, B.get(bg)!);
  }
  const total = (a.length - 1) + (b.length - 1);
  return total <= 0 ? 0 : (2 * intersection) / total;
}

// ---------------------------------------------------------------------------
// Auto-fill suggestions (returned to the UI for the user to review)
// ---------------------------------------------------------------------------

async function autofillSuggestions(
  root: SceneNode,
  mappings: ReadonlyArray<ComponentMapping>,
  components: ReadonlyArray<FEComponentCatalogItem>
): Promise<AutofillSuggestion[]> {
  const seen = new Map<string, AutofillSuggestion>();
  await walkAsync(root, async (n) => {
    if (n.type !== "INSTANCE") return;
    const mc = await tryGetMain(n as InstanceNode);
    const figmaName = mc?.name ?? n.name;
    const key = mc?.key ?? figmaName;
    if (seen.has(key)) return;

    const sticky = readStickyMappingId(n);
    const exact = matchMapping(
      {
        figmaName,
        figmaComponentKey: mc?.key,
        figmaNodeId: n.id,
        stickyMappingId: sticky,
      },
      mappings,
      components
    );

    // Top up to 3 catalog candidates by score.
    const ranked: AutofillSuggestion["candidates"] = [];
    if (exact) {
      ranked.push({
        codeComponent: exact.mapping.codeComponent,
        codeFilePath: exact.mapping.codeFilePath,
        confidence: exact.confidence,
        reason: exact.reason,
      });
    }
    for (const c of components) {
      const cn = normaliseName(c.componentName);
      const target = normaliseName(figmaName);
      const sim = diceCoefficient(cn, target);
      if (sim < 0.4) continue;
      if (ranked.some((r) => r.codeComponent === c.componentName)) continue;
      ranked.push({
        codeComponent: c.componentName,
        codeFilePath: c.filePath,
        confidence: 0.3 + sim * 0.5,
        reason: `catalog-fuzzy(${sim.toFixed(2)})`,
      });
    }
    ranked.sort((a, b) => b.confidence - a.confidence);

    seen.set(key, {
      figmaName,
      figmaNodeId: n.id,
      figmaComponentKey: mc?.key,
      candidates: ranked.slice(0, 3),
    });
  });

  return Array.from(seen.values()).sort((a, b) =>
    a.figmaName.localeCompare(b.figmaName)
  );
}

// ---------------------------------------------------------------------------
// Compressed spec builder (Match + Prune + Tokens + Assets)
// ---------------------------------------------------------------------------

async function buildCompressedSpec(
  root: SceneNode,
  mappings: ReadonlyArray<ComponentMapping>,
  components: ReadonlyArray<FEComponentCatalogItem>,
  tokenCatalog: ReadonlyArray<FETokenCatalogItem>
): Promise<CompressedSpec> {
  const localVars = await loadLocalVariables();
  const ctx: BuildCtx = {
    mappings,
    components,
    tokenCatalog,
    localVars,
    tokens: new Map(),
    assets: [],
    matched: 0,
    unmatched: 0,
    ignored: 0,
    totalInstances: 0,
    confidenceSum: 0,
    matchedDetails: [],
    unmatchedDetails: [],
    componentsUsed: new Map(),
  };

  const root_spec = await buildNode(root, ctx, /* isRoot */ true);

  const matchedAvg = ctx.matched ? ctx.confidenceSum / ctx.matched : 0;
  const tokenCoverage =
    ctx.tokens.size === 0
      ? 1
      : Array.from(ctx.tokens.values()).filter((t) => t.codeTokenName).length /
        ctx.tokens.size;

  const report: MappingReport = {
    matched: ctx.matched,
    unmatched: ctx.unmatched,
    ignored: ctx.ignored,
    totalInstances: ctx.totalInstances,
    tokenCoverage,
    confidence: matchedAvg,
    matchedDetails: ctx.matchedDetails,
    unmatchedDetails: ctx.unmatchedDetails,
    missingTokens: Array.from(ctx.tokens.values())
      .filter((t) => !t.codeTokenName)
      .map((t) => ({ figmaTokenName: t.figmaTokenName, type: t.type })),
  };

  return {
    version: PLUGIN_VERSION,
    source: "figma-to-vscode-sender",
    createdAt: new Date().toISOString(),
    figma: {
      fileName: figma.root.name,
      pageName: figma.currentPage.name,
      selectedNodeId: root.id,
      selectedNodeName: root.name,
    },
    screen: {
      name: root.name,
      width: "width" in root ? root.width : 0,
      height: "height" in root ? root.height : 0,
      children: Array.isArray((root_spec as LayoutSpec).children)
        ? ((root_spec as LayoutSpec).children as SpecNode[])
        : [root_spec],
    },
    componentsUsed: Array.from(ctx.componentsUsed.values()),
    tokens: Array.from(ctx.tokens.values()),
    assets: ctx.assets,
    mappingReport: report,
  };
}

interface BuildCtx {
  mappings: ReadonlyArray<ComponentMapping>;
  components: ReadonlyArray<FEComponentCatalogItem>;
  tokenCatalog: ReadonlyArray<FETokenCatalogItem>;
  localVars: Map<string, Variable>;

  tokens: Map<string, DesignTokenRef>;
  assets: AssetRef[];

  matched: number;
  unmatched: number;
  ignored: number;
  totalInstances: number;
  confidenceSum: number;
  matchedDetails: MappingReport["matchedDetails"];
  unmatchedDetails: MappingReport["unmatchedDetails"];
  componentsUsed: Map<
    string,
    {
      figmaName: string;
      codeComponent: string;
      codeFilePath: string;
      importType: "default" | "named";
      importName?: string;
      confidence: number;
      occurrences: number;
    }
  >;
}

async function buildNode(
  n: SceneNode,
  ctx: BuildCtx,
  // When true, this is the node the user explicitly selected. We never prune
  // the root: even if it matches a mapping, we serialize its full subtree so
  // the user sees the content, not just a single component_ref wrapper.
  isRoot: boolean = false
): Promise<SpecNode> {
  // Visibility & ignore mark
  if (!("visible" in n) || n.visible === false) {
    // Fall through but mark as ignored layout node; could also drop entirely.
  }

  const mark = getMark(n);
  if (mark === "ignored") {
    ctx.ignored++;
    return {
      type: "layout_node",
      name: n.name,
      figmaNodeId: n.id,
      figmaType: n.type,
    };
  }

  // Asset marks short-circuit children and produce an asset_ref.
  if (mark === "icon" || mark === "image" || mark === "vector") {
    const ref = await exportAssetForNode(n, mark, ctx);
    if (ref) {
      const spec: AssetRefSpec = {
        type: "asset_ref",
        assetType: mark,
        name: ref.name,
        path: ref.path,
        figmaNodeId: n.id,
      };
      return spec;
    }
  }

  // INSTANCE → mapping?
  // For the user-selected root, we deliberately skip the prune-to-ref path
  // and treat it like a layout node so the full content is visible. Nested
  // INSTANCEs further down are still pruned normally.
  if (n.type === "INSTANCE" && !isRoot) {
    ctx.totalInstances++;
    const mc = await tryGetMain(n as InstanceNode);
    const figmaName = mc?.name ?? n.name;
    const sticky = readStickyMappingId(n);
    const match = matchMapping(
      {
        figmaName,
        figmaComponentKey: mc?.key,
        figmaNodeId: n.id,
        stickyMappingId: sticky,
      },
      ctx.mappings,
      ctx.components
    );

    if (match) {
      ctx.matched++;
      ctx.confidenceSum += match.confidence;
      ctx.matchedDetails.push({
        figmaName,
        codeComponent: match.mapping.codeComponent,
        confidence: match.confidence,
      });

      const key = match.mapping.codeComponent + "@" + match.mapping.codeFilePath;
      const existing = ctx.componentsUsed.get(key);
      if (existing) existing.occurrences++;
      else {
        ctx.componentsUsed.set(key, {
          figmaName,
          codeComponent: match.mapping.codeComponent,
          codeFilePath: match.mapping.codeFilePath,
          importType: match.mapping.importType,
          importName: match.mapping.importName,
          confidence: match.confidence,
          occurrences: 1,
        });
      }

      // Design payload (visible texts + nested matched components) rather
      // than typed props — the AI consumer infers real prop names from the
      // source file. Auto-generated camelCase prop keys from text values
      // produced noise like `toApr92026441PM` and were dropped.
      const content = await collectContent(n, ctx);

      const spec: ComponentRefSpec = {
        type: "component_ref",
        figmaName,
        figmaNodeId: n.id,
        codeComponent: match.mapping.codeComponent,
        codeFilePath: match.mapping.codeFilePath,
        importType: match.mapping.importType,
        importName: match.mapping.importName,
        ...(content ? { content } : {}),
        pruned: true,
        confidence: match.confidence,
      };
      // Don't descend into children — they are implementation details of the
      // matched code component. (Content collection above already pulled out
      // the texts + nested matched components we actually need.)
      return spec;
    } else {
      ctx.unmatched++;
      ctx.unmatchedDetails.push({
        figmaName,
        figmaType: n.type,
        nodeId: n.id,
      });
      // Fall through and treat as a layout node so the design intent isn't lost.
    }
  }

  // FRAME / GROUP / SECTION / COMPONENT → user-mapped to a code component?
  // The Table -> IposTable case: the user maps a regular FRAME (not an
  // INSTANCE) to a component file via the tree-node panel. We collapse the
  // subtree the same way we do for INSTANCEs, then infer props from the
  // direct children (text → string props, nested matched components →
  // nested component_refs). The selected root is excluded so the user can
  // still see the body of what they exported.
  if (!isRoot && isMappableContainer(n.type)) {
    const sticky = readStickyMappingId(n);
    const match = matchMapping(
      {
        figmaName: n.name,
        figmaNodeId: n.id,
        stickyMappingId: sticky,
      },
      ctx.mappings,
      ctx.components
    );
    if (match) {
      ctx.matched++;
      ctx.totalInstances++;
      ctx.confidenceSum += match.confidence;
      ctx.matchedDetails.push({
        figmaName: n.name,
        codeComponent: match.mapping.codeComponent,
        confidence: match.confidence,
      });
      const key = match.mapping.codeComponent + "@" + match.mapping.codeFilePath;
      const existing = ctx.componentsUsed.get(key);
      if (existing) existing.occurrences++;
      else {
        ctx.componentsUsed.set(key, {
          figmaName: n.name,
          codeComponent: match.mapping.codeComponent,
          codeFilePath: match.mapping.codeFilePath,
          importType: match.mapping.importType,
          importName: match.mapping.importName,
          confidence: match.confidence,
          occurrences: 1,
        });
      }
      // Same content-vs-props distinction as the INSTANCE branch above.
      const content = await collectContent(n, ctx);
      const spec: ComponentRefSpec = {
        type: "component_ref",
        figmaName: n.name,
        figmaNodeId: n.id,
        codeComponent: match.mapping.codeComponent,
        codeFilePath: match.mapping.codeFilePath,
        importType: match.mapping.importType,
        importName: match.mapping.importName,
        ...(content ? { content } : {}),
        pruned: true,
        confidence: match.confidence,
      };
      return spec;
    }
  }

  // TEXT → text_node with typography token
  if (n.type === "TEXT") {
    return await buildTextNode(n as TextNode, ctx);
  }

  // Default → layout_node with extracted layout + (compact) styles + recurse
  const layout = extractLayout(n);
  const styles = await extractStylesWithTokens(n, ctx);
  const children: SpecNode[] = [];
  if ("children" in n) {
    for (const c of (n as ChildrenMixin).children as SceneNode[]) {
      children.push(await buildNode(c, ctx));
    }
  }
  const spec: LayoutSpec = {
    type: "layout_node",
    name: n.name,
    figmaNodeId: n.id,
    figmaType: n.type,
    layout,
    styles,
    children: children.length ? children : undefined,
  };
  return spec;
}

function isMappableContainer(type: string): boolean {
  return (
    type === "FRAME" ||
    type === "GROUP" ||
    type === "SECTION" ||
    type === "COMPONENT" ||
    type === "COMPONENT_SET"
  );
}

// Maximum number of text records emitted per matched component. The AI
// only needs enough samples to infer the row shape — past ~200 entries the
// payload turns into noise. When truncated, the lean spec flags it so
// consumers know data was elided.
const MAX_CONTENT_TEXTS = 200;

// Walks a matched component's subtree and emits the design payload the AI
// consumer needs to bind to real props:
//   - texts: every visible TEXT node in document order, keeping the Figma
//     layer name (the strongest hint for prop mapping)
//   - components: nested matched components, recursively (so the
//     "Card has Action button" structure survives)
// Unmatched layout wrappers (frames, groups) are transparent — they don't
// generate their own entries, but their descendants bubble up into the
// matched parent's content. This is the inverse of the previous behaviour
// which auto-invented prop names like `toApr92026441PM` from text values:
// here, we don't pretend to know the typed prop signature. The AI reads the
// real source file (`.vue`/`.tsx`/`.component.ts`) to discover prop names,
// then matches them to these strings itself.
async function collectContent(
  n: SceneNode,
  ctx: BuildCtx
): Promise<ComponentContent | undefined> {
  const texts: ComponentContentText[] = [];
  const components: SpecNode[] = [];
  await walkContent(n, texts, components, ctx, 0);

  const truncated = texts.length > MAX_CONTENT_TEXTS;
  const finalTexts = truncated ? texts.slice(0, MAX_CONTENT_TEXTS) : texts;

  if (finalTexts.length === 0 && components.length === 0) {
    return undefined;
  }

  const content: ComponentContent = {};
  if (finalTexts.length) content.texts = finalTexts;
  if (components.length) content.components = components;
  if (truncated) content.truncated = true;
  return content;
}

async function walkContent(
  n: SceneNode,
  texts: ComponentContentText[],
  components: SpecNode[],
  ctx: BuildCtx,
  depth: number
): Promise<void> {
  if (depth > 8) return;
  if (!("children" in n)) return;

  for (const child of (n as ChildrenMixin).children as SceneNode[]) {
    if ("visible" in child && child.visible === false) continue;

    if (child.type === "TEXT") {
      const value = typeof (child as TextNode).characters === "string"
        ? (child as TextNode).characters.trim()
        : "";
      if (value) {
        texts.push({ name: child.name, value });
      }
      continue;
    }

    // Matched child (INSTANCE or any container with a mapping) → emit as a
    // nested SpecNode by going back through buildNode, so the same stats /
    // sticky-tag path applies.
    let figmaName = child.name;
    let figmaComponentKey: string | undefined;
    if (child.type === "INSTANCE") {
      const mc = await tryGetMain(child as InstanceNode);
      figmaName = mc?.name ?? child.name;
      figmaComponentKey = mc?.key;
    }
    const childSticky = readStickyMappingId(child);
    const childMatch = matchMapping(
      {
        figmaName,
        figmaComponentKey,
        figmaNodeId: child.id,
        stickyMappingId: childSticky,
      },
      ctx.mappings,
      ctx.components
    );
    if (childMatch) {
      components.push(await buildNode(child, ctx, false));
      continue;
    }

    // Unmatched wrapper — walk through transparently so its useful
    // descendants surface on the parent matched component.
    if ("children" in child) {
      await walkContent(child, texts, components, ctx, depth + 1);
    }
  }
}

function extractLayout(n: SceneNode): Record<string, unknown> | undefined {
  if (!("layoutMode" in n)) return undefined;
  const m = n as unknown as {
    layoutMode?: string;
    itemSpacing?: number;
    paddingLeft?: number; paddingRight?: number;
    paddingTop?: number; paddingBottom?: number;
    primaryAxisAlignItems?: string;
    counterAxisAlignItems?: string;
    primaryAxisSizingMode?: string;
    counterAxisSizingMode?: string;
    layoutWrap?: string;
  };
  if (!m.layoutMode || m.layoutMode === "NONE") return undefined;
  return {
    display: "flex",
    direction: m.layoutMode === "HORIZONTAL" ? "row" : "column",
    gap: m.itemSpacing,
    padding: {
      left: m.paddingLeft, right: m.paddingRight,
      top: m.paddingTop, bottom: m.paddingBottom,
    },
    justify: m.primaryAxisAlignItems,
    align: m.counterAxisAlignItems,
    wrap: m.layoutWrap,
    sizing: {
      primary: m.primaryAxisSizingMode,
      counter: m.counterAxisSizingMode,
    },
  };
}

async function extractStylesWithTokens(
  n: SceneNode,
  ctx: BuildCtx
): Promise<Record<string, unknown> | undefined> {
  const anyN = n as unknown as {
    fills?: ReadonlyArray<Paint> | symbol;
    strokes?: ReadonlyArray<Paint>;
    strokeWeight?: number | symbol;
    cornerRadius?: number | symbol;
    effects?: ReadonlyArray<Effect>;
    opacity?: number;
    boundVariables?: Record<string, unknown>;
  };

  const hasAny =
    "fills" in n || "strokes" in n || "cornerRadius" in n || "effects" in n;
  if (!hasAny) return undefined;

  const out: Record<string, unknown> = {};

  if (Array.isArray(anyN.fills)) {
    out.fills = (anyN.fills as Paint[]).map((p, i) =>
      paintWithToken(p, n, "fills", i, ctx)
    );
  }
  if (Array.isArray(anyN.strokes)) {
    out.strokes = (anyN.strokes as Paint[]).map((p, i) =>
      paintWithToken(p, n, "strokes", i, ctx)
    );
  }
  if (typeof anyN.strokeWeight === "number") out.strokeWeight = anyN.strokeWeight;
  if (typeof anyN.cornerRadius === "number") {
    out.cornerRadius = cornerRadiusWithToken(
      anyN.cornerRadius,
      n,
      "cornerRadius",
      ctx
    );
  }
  if (Array.isArray(anyN.effects) && anyN.effects.length) {
    out.effects = anyN.effects.map((e) => ({
      kind: e.type,
      raw: e,
    }));
    for (const e of anyN.effects) {
      registerEffectToken(e, ctx);
    }
  }
  if (typeof anyN.opacity === "number" && anyN.opacity !== 1) {
    out.opacity = anyN.opacity;
  }
  return out;
}

function paintWithToken(
  p: Paint,
  node: SceneNode,
  field: string,
  index: number,
  ctx: BuildCtx
): Record<string, unknown> {
  const ref = bindingForField(node, `${field}.${index}`);
  const variable = ref ? ctx.localVars.get(ref) : null;
  if (variable) {
    const tok = registerVariableToken(variable, "color", ctx, p);
    return { tokenRef: tok.figmaTokenName, raw: p };
  }
  if (p.type === "SOLID") {
    return { hex: rgbToHex(p.color, p.opacity ?? 1), raw: p };
  }
  return { raw: p };
}

function cornerRadiusWithToken(
  value: number,
  node: SceneNode,
  field: string,
  ctx: BuildCtx
): unknown {
  const ref = bindingForField(node, field);
  const variable = ref ? ctx.localVars.get(ref) : null;
  if (variable) {
    const tok = registerVariableToken(variable, "radius", ctx, value);
    return { tokenRef: tok.figmaTokenName, raw: value };
  }
  return value;
}

function bindingForField(node: SceneNode, field: string): string | null {
  try {
    const bv = (node as unknown as { boundVariables?: Record<string, unknown> })
      .boundVariables;
    if (!bv) return null;
    // boundVariables can be nested like { fills: [{type:'VARIABLE_ALIAS', id}] }
    const path = field.split(".");
    let cur: unknown = bv;
    for (const seg of path) {
      if (cur && typeof cur === "object") {
        const idx = Number(seg);
        cur = !isNaN(idx)
          ? (cur as unknown[])[idx]
          : (cur as Record<string, unknown>)[seg];
      } else {
        return null;
      }
    }
    if (cur && typeof cur === "object" && (cur as { id?: string }).id) {
      return (cur as { id: string }).id;
    }
    return null;
  } catch {
    return null;
  }
}

function registerVariableToken(
  v: Variable,
  type: TokenKind,
  ctx: BuildCtx,
  rawValue: unknown
): DesignTokenRef {
  const key = `var:${v.id}`;
  const existing = ctx.tokens.get(key);
  if (existing) {
    existing.usageCount++;
    return existing;
  }
  const match = matchTokenName(v.name, ctx.tokenCatalog);
  const ref: DesignTokenRef = {
    figmaTokenName: v.name,
    figmaVariableId: v.id,
    type,
    value: rawValue,
    codeTokenName: match?.name,
    codeTokenPath: match?.filePath,
    confidence: match?.score,
    usageCount: 1,
  };
  ctx.tokens.set(key, ref);
  return ref;
}

function registerEffectToken(e: Effect, ctx: BuildCtx): void {
  // Effects styles via styleId would require figma.getStyleByIdAsync; we
  // skip the round-trip and key by canonical JSON for dedupe stats.
  const key = `effect:${JSON.stringify(e)}`;
  const existing = ctx.tokens.get(key);
  if (existing) {
    existing.usageCount++;
    return;
  }
  ctx.tokens.set(key, {
    figmaTokenName: `effect/${e.type.toLowerCase()}`,
    type: "shadow",
    value: e,
    usageCount: 1,
  });
}

function matchTokenName(
  figmaName: string,
  catalog: ReadonlyArray<FETokenCatalogItem>
): { name: string; filePath?: string; score: number } | null {
  if (!catalog.length) return null;
  const target = normaliseName(figmaName);
  let best: { name: string; filePath?: string; score: number } | null = null;
  for (const t of catalog) {
    const sim = diceCoefficient(normaliseName(t.name), target);
    if (sim < 0.55) continue;
    if (!best || sim > best.score) {
      best = { name: t.name, filePath: t.filePath, score: sim };
    }
  }
  return best;
}

function rgbToHex(c: RGB, a: number): string {
  const ch = (x: number) =>
    Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
  const hex = `#${ch(c.r)}${ch(c.g)}${ch(c.b)}`;
  return a < 1 ? `${hex}${ch(a)}` : hex;
}

async function buildTextNode(n: TextNode, ctx: BuildCtx): Promise<TextSpec> {
  const family =
    typeof n.fontName === "object" ? n.fontName.family : undefined;
  const style =
    typeof n.fontName === "object" ? n.fontName.style : undefined;

  // Try fillStyleId for typography token name.
  let tokenRef: string | undefined;
  try {
    const sid = (n as unknown as { textStyleId?: string | symbol }).textStyleId;
    if (typeof sid === "string" && sid) {
      const style = await figma.getStyleByIdAsync(sid);
      if (style) tokenRef = style.name;
    }
  } catch { /* ignore */ }

  if (tokenRef) {
    const key = `typo:${tokenRef}`;
    if (!ctx.tokens.has(key)) {
      ctx.tokens.set(key, {
        figmaTokenName: tokenRef,
        type: "typography",
        value: { family, style, size: n.fontSize },
        usageCount: 1,
        ...(matchTokenName(tokenRef, ctx.tokenCatalog) ?? {}),
      });
    } else {
      ctx.tokens.get(key)!.usageCount++;
    }
  }

  return {
    type: "text_node",
    name: n.name,
    figmaNodeId: n.id,
    text: typeof n.characters === "string" ? n.characters : "",
    typography: {
      tokenRef,
      raw: {
        family,
        style,
        size: typeof n.fontSize === "number" ? n.fontSize : undefined,
        lineHeight: typeof n.lineHeight === "object" ? n.lineHeight : undefined,
        letterSpacing:
          typeof n.letterSpacing === "object" ? n.letterSpacing : undefined,
        align: n.textAlignHorizontal,
        valign: n.textAlignVertical,
        case: n.textCase,
        decoration: n.textDecoration,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

async function loadLocalVariables(): Promise<Map<string, Variable>> {
  const map = new Map<string, Variable>();
  try {
    const fn = (figma.variables as unknown as {
      getLocalVariablesAsync?: () => Promise<Variable[]>;
    }).getLocalVariablesAsync;
    let list: Variable[] = [];
    if (typeof fn === "function") list = await fn.call(figma.variables);
    else if (typeof figma.variables.getLocalVariables === "function")
      list = figma.variables.getLocalVariables();
    for (const v of list) map.set(v.id, v);
  } catch { /* ignore */ }
  return map;
}

// ---------------------------------------------------------------------------
// Asset marking + export
// ---------------------------------------------------------------------------

function getMark(n: SceneNode): AssetMark {
  try {
    const v = n.getPluginData(PLUGIN_DATA_MARK);
    if (!v) return null;
    if (
      v === "icon" || v === "image" || v === "vector" ||
      v === "illustration" || v === "decorative" || v === "ignored"
    ) return v;
    return null;
  } catch {
    return null;
  }
}

function readStickyMappingId(n: SceneNode): string | undefined {
  try {
    if (!("getPluginData" in n)) return undefined;
    const id = (n as BaseNode).getPluginData(PLUGIN_DATA_MAPPING_ID);
    return id && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

async function exportAssetForNode(
  n: SceneNode,
  kind: "icon" | "image" | "vector",
  ctx: BuildCtx
): Promise<AssetRef | null> {
  try {
    if (!("exportAsync" in n)) return null;
    const format: "svg" | "png" = kind === "image" ? "png" : "svg";
    const data =
      format === "svg"
        ? await (n as ExportMixin).exportAsync({ format: "SVG" })
        : await (n as ExportMixin).exportAsync({
            format: "PNG",
            constraint: { type: "SCALE", value: 2 },
          });
    const name = slugify(n.name) || "asset";
    const folder = kind === "icon" ? "icons" : kind === "vector" ? "vectors" : "images";
    const path = `@${folder}/${name}.${format}`;
    const ref: AssetRef = {
      type: kind,
      name,
      path,
      figmaNodeId: n.id,
      base64: uint8ToBase64(data),
      format,
    };
    ctx.assets.push(ref);
    return ref;
  } catch {
    return null;
  }
}

function slugify(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Walks a node and pushes the node itself plus every visible descendant.
// Hidden subtrees are skipped because selecting them confuses the user (they
// can't see what's highlighted in the viewport).
function collectVisibleDescendants(
  n: SceneNode,
  out: SceneNode[],
  seen: Set<string>
): void {
  if (seen.has(n.id)) return;
  if (n.visible === false) return;
  seen.add(n.id);
  out.push(n);
  if ("children" in n) {
    for (const c of (n as ChildrenMixin).children as SceneNode[]) {
      collectVisibleDescendants(c, out, seen);
    }
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Lean spec — strips Figma internals so the consumer sees codeComponent +
// codeFilePath + props, exactly the shape an AI agent needs to assemble the
// page from existing source components.
// ---------------------------------------------------------------------------

export function buildLeanSpec(spec: CompressedSpec): LeanSpec {
  const r = spec.mappingReport;
  return {
    version: spec.version,
    createdAt: spec.createdAt,
    figma: {
      fileName: spec.figma.fileName,
      pageName: spec.figma.pageName,
      selectedNodeName: spec.figma.selectedNodeName,
    },
    screen: {
      name: spec.screen.name,
      width: spec.screen.width,
      height: spec.screen.height,
      children: spec.screen.children
        .map(toLeanNode)
        .filter((n): n is LeanNode => n !== null),
    },
    componentsUsed: spec.componentsUsed.map((c) => ({
      codeComponent: c.codeComponent,
      codeFilePath: c.codeFilePath,
      importType: c.importType,
      ...(c.importName ? { importName: c.importName } : {}),
      occurrences: c.occurrences,
    })),
    tokens: spec.tokens.map((t) => ({
      name: t.figmaTokenName,
      type: t.type,
      ...(t.codeTokenName ? { codeTokenName: t.codeTokenName } : {}),
      ...(t.codeTokenPath ? { codeTokenPath: t.codeTokenPath } : {}),
      usageCount: t.usageCount,
    })),
    assets: spec.assets.map((a) => ({
      type: a.type,
      name: a.name,
      path: a.path,
      format: a.format,
    })),
    stats: {
      totalInstances: r.totalInstances,
      matched: r.matched,
      unmatched: r.unmatched,
      confidence: r.confidence,
      tokenCoverage: r.tokenCoverage,
    },
  };
}

function toLeanNode(node: SpecNode): LeanNode | null {
  switch (node.type) {
    case "component_ref": {
      const out: LeanComponent = {
        codeComponent: node.codeComponent,
        codeFilePath: node.codeFilePath,
      };
      // importType / importName only matter when they differ from the safe
      // default ("named" + same name). Hide them when redundant.
      if (node.importType === "default") {
        out.importType = "default";
        if (node.importName && node.importName !== node.codeComponent) {
          out.importName = node.importName;
        }
      }
      if (node.content) {
        const leanContent = leanifyContent(node.content);
        if (leanContent) {
          out.content = leanContent;
        }
      }
      // ComponentRefSpec only has `children` when an upstream mapping kept
      // them; the default flow prunes them. Pass them through when present
      // so the structural intent isn't lost.
      if (node.children?.length) {
        const kids = node.children
          .map(toLeanNode)
          .filter((c): c is LeanNode => c !== null);
        if (kids.length) {
          out.children = kids;
        }
      }
      return out;
    }
    case "layout_node": {
      const kids = (node.children ?? [])
        .map(toLeanNode)
        .filter((c): c is LeanNode => c !== null);
      // Drop pure wrapper frames that produced no useful subtree.
      if (kids.length === 0 && !node.layout && !node.styles) {
        return null;
      }
      const out: LeanLayout = {
        layout: describeLayout(node),
      };
      if (node.styles && Object.keys(node.styles).length > 0) {
        const cleanedStyles = cleanStyles(node.styles);
        if (Object.keys(cleanedStyles).length > 0) {
          out.styles = cleanedStyles;
        }
      }
      if (kids.length) {
        out.children = kids;
      }
      return out;
    }
    case "text_node": {
      const out: LeanText = { text: node.text };
      const tokenRef = node.typography?.tokenRef;
      if (tokenRef) {
        out.typography = tokenRef;
      }
      return out;
    }
    case "asset_ref": {
      const out: LeanAsset = {
        asset: node.assetType,
        path: node.path,
        name: node.name,
      };
      return out;
    }
  }
}

// Render a layout_node's auto-layout intent as a short string the consumer can
// scan visually (e.g. "row gap:8 pad:16,24,16,24"). Falls back to "container"
// when the node has no auto-layout configuration.
function describeLayout(node: LayoutSpec): string {
  const layout = node.layout as
    | {
        display?: string;
        direction?: string;
        gap?: number;
        padding?: { top?: number; right?: number; bottom?: number; left?: number };
        justify?: string;
        align?: string;
      }
    | undefined;
  if (!layout || !layout.direction) {
    return node.name || "container";
  }
  const parts: string[] = [layout.direction === "row" ? "row" : "column"];
  if (typeof layout.gap === "number" && layout.gap !== 0) {
    parts.push(`gap:${layout.gap}`);
  }
  if (layout.padding) {
    const { top = 0, right = 0, bottom = 0, left = 0 } = layout.padding;
    if (top || right || bottom || left) {
      parts.push(`pad:${top},${right},${bottom},${left}`);
    }
  }
  if (layout.justify && layout.justify !== "MIN") {
    parts.push(`justify:${layout.justify.toLowerCase()}`);
  }
  if (layout.align && layout.align !== "MIN") {
    parts.push(`align:${layout.align.toLowerCase()}`);
  }
  return parts.join(" ");
}

// Converts a ComponentContent (spec side, with full SpecNode children) into
// a LeanContent (lean side, with LeanNode children) by leaning any nested
// matched components and copying the text records as-is.
function leanifyContent(content: ComponentContent): LeanContent | undefined {
  const out: LeanContent = {};
  if (content.texts && content.texts.length) {
    out.texts = content.texts;
  }
  if (content.components && content.components.length) {
    const leanComponents = content.components
      .map(toLeanNode)
      .filter((c): c is LeanNode => c !== null);
    if (leanComponents.length) {
      out.components = leanComponents;
    }
  }
  if (content.truncated) {
    out.truncated = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function cleanStyles(styles: Record<string, unknown>): Record<string, unknown> {
  // Pull the most useful single value (tokenRef / hex) out of nested raw fills
  // so the lean spec stays scannable. Anything obscure passes through as-is.
  const out: Record<string, unknown> = {};

  const fills = styles.fills;
  if (Array.isArray(fills) && fills.length > 0) {
    const first = fills[0] as { tokenRef?: string; hex?: string };
    if (first?.tokenRef) {
      out.fill = first.tokenRef;
    } else if (first?.hex) {
      out.fill = first.hex;
    }
  }

  const strokes = styles.strokes;
  if (Array.isArray(strokes) && strokes.length > 0) {
    const first = strokes[0] as { tokenRef?: string; hex?: string };
    if (first?.tokenRef) {
      out.stroke = first.tokenRef;
    } else if (first?.hex) {
      out.stroke = first.hex;
    }
  }

  if (typeof styles.cornerRadius === "number") {
    out.radius = styles.cornerRadius;
  } else if (
    styles.cornerRadius &&
    typeof styles.cornerRadius === "object" &&
    (styles.cornerRadius as { tokenRef?: string }).tokenRef
  ) {
    out.radius = (styles.cornerRadius as { tokenRef: string }).tokenRef;
  }

  if (Array.isArray(styles.effects) && styles.effects.length > 0) {
    out.shadow = "yes";
  }
  if (typeof styles.opacity === "number") {
    out.opacity = styles.opacity;
  }
  return out;
}
