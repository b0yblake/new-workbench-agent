// types.ts — shared between code.ts (main runtime) and ui.ts (iframe).

export const PLUGIN_NAME = "Figma to VS Code Sender";
export const PLUGIN_VERSION = "0.3.0";

// ---------- Component mapping registry --------------------------------------

export interface ComponentMapping {
  id: string;
  figmaName: string;
  figmaNodeId?: string;
  figmaComponentKey?: string;
  figmaVariant?: Record<string, string>;

  codeComponent: string;
  codeFilePath: string;
  importType: "default" | "named";
  importName?: string;

  propMapping?: Record<string, string>; // figmaProp → codeProp
  defaultProps?: Record<string, unknown>;
  mergeChildProps?: boolean;

  confidence: number; // 0..1
  source: "manual" | "auto-suggested" | "confirmed";
  updatedAt: string;

  // Optional metadata shown in the Component Records Manager
  previewUiUrl?: string;
  description?: string;
}

// ---------- Per-node marks (asset / ignore) ---------------------------------

export type AssetMark =
  | "icon"
  | "image"
  | "vector"
  | "illustration"
  | "decorative"
  | "ignored"
  | null;

// ---------- Catalogs received from VS Code ----------------------------------

export interface FEComponentCatalogItem {
  componentName: string;
  filePath: string;
  exportType: "default" | "named";
  props?: Array<{ name: string; type: string }>;
  framework?: string;
  aliases?: string[];
  examples?: string[];
}

export interface FETokenCatalogItem {
  name: string;
  value: unknown;
  filePath?: string;
  type?: TokenKind;
}

export type TokenKind =
  | "color"
  | "spacing"
  | "typography"
  | "radius"
  | "shadow"
  | "opacity"
  | "other";

// ---------- Design tokens extracted from the Figma selection ---------------

export interface DesignTokenRef {
  figmaTokenName: string;
  figmaVariableId?: string;
  figmaStyleId?: string;
  type: TokenKind;
  value: unknown;
  codeTokenName?: string;
  codeTokenPath?: string;
  confidence?: number;
  usageCount: number;
}

// ---------- Assets -----------------------------------------------------------

export interface AssetRef {
  type: "icon" | "image" | "vector";
  name: string;
  path: string; // virtual reference such as @icons/search.svg
  figmaNodeId: string;
  base64?: string; // raw bytes for VS Code to write to disk
  format: "svg" | "png";
}

// ---------- Compressed spec sent to VS Code ---------------------------------

export type SpecNode =
  | ComponentRefSpec
  | LayoutSpec
  | TextSpec
  | AssetRefSpec;

// Text payload found inside a matched component, in document order.
// The Figma layer name is the strongest signal an AI has for mapping a string
// to a real prop ("Title" → title, "Request ID" → not a prop but a column
// header). We keep both name and value so the AI doesn't lose intent.
export interface ComponentContentText {
  name: string;
  value: string;
}

// Design payload carried by a matched component. Not typed props — the AI
// reads the real source file (.vue / .tsx / .component.ts) to discover the
// component's actual prop signatures and binds these strings to them.
export interface ComponentContent {
  texts?: ComponentContentText[];
  components?: SpecNode[];
  truncated?: boolean;
}

export interface ComponentRefSpec {
  type: "component_ref";
  figmaName: string;
  figmaNodeId: string;
  codeComponent: string;
  codeFilePath: string;
  importType: "default" | "named";
  importName?: string;
  content?: ComponentContent;
  children?: SpecNode[];
  pruned: true;
  confidence: number;
}

export interface LayoutSpec {
  type: "layout_node";
  name: string;
  figmaNodeId: string;
  figmaType: string;
  layout?: Record<string, unknown>;
  styles?: Record<string, unknown>;
  children?: SpecNode[];
}

export interface TextSpec {
  type: "text_node";
  name: string;
  figmaNodeId: string;
  text: string;
  typography?: { id?: string; tokenRef?: string; raw?: Record<string, unknown> };
  fill?: { tokenRef?: string; raw?: unknown };
}

export interface AssetRefSpec {
  type: "asset_ref";
  assetType: "icon" | "image" | "vector";
  name: string;
  path: string;
  figmaNodeId: string;
}

export interface MappingReport {
  matched: number;
  unmatched: number;
  ignored: number;
  totalInstances: number;
  tokenCoverage: number; // 0..1
  confidence: number; // 0..1 average over matched
  matchedDetails: Array<{
    figmaName: string;
    codeComponent: string;
    confidence: number;
  }>;
  unmatchedDetails: Array<{
    figmaName: string;
    figmaType: string;
    nodeId: string;
  }>;
  missingTokens: Array<{ figmaTokenName: string; type: TokenKind }>;
}

export interface CompressedSpec {
  version: string;
  source: string;
  createdAt: string;
  figma: {
    fileName: string;
    pageName: string;
    selectedNodeId: string;
    selectedNodeName: string;
  };
  screen: {
    name: string;
    width: number;
    height: number;
    children: SpecNode[];
  };
  componentsUsed: Array<{
    figmaName: string;
    codeComponent: string;
    codeFilePath: string;
    importType: "default" | "named";
    importName?: string;
    confidence: number;
    occurrences: number;
  }>;
  tokens: DesignTokenRef[];
  assets: AssetRef[];
  mappingReport: MappingReport;
}

// ---------- Lean (path-based) export ----------------------------------------
//
// The lean spec is what the AI consumer actually needs: which code components
// to use and where they live. All Figma internals (node ids, raw shape data)
// are stripped. Matched components collapse to {codeComponent, codeFilePath,
// props, children?}; unmatched nodes keep just enough structure to convey
// design intent.

export type LeanNode =
  | LeanComponent
  | LeanLayout
  | LeanText
  | LeanAsset;

// Lean-side content mirrors ComponentContent but its `components` array
// holds LeanNodes (already stripped of Figma internals) rather than full
// SpecNodes.
export interface LeanContent {
  texts?: ComponentContentText[];
  components?: LeanNode[];
  truncated?: boolean;
}

export interface LeanComponent {
  codeComponent: string;
  codeFilePath: string;
  importType?: "default" | "named";
  importName?: string;
  // `content` carries design payload (visible texts + nested matched
  // components), NOT typed component props. The AI in the VS Code extension
  // reads the real source file to discover the component's prop signature,
  // then binds these strings to the right props itself.
  content?: LeanContent;
  children?: LeanNode[];
}

export interface LeanLayout {
  layout: string;
  styles?: Record<string, unknown>;
  text?: string;
  children?: LeanNode[];
}

export interface LeanText {
  text: string;
  typography?: string;
}

export interface LeanAsset {
  asset: "icon" | "image" | "vector";
  path: string;
  name?: string;
}

export interface LeanSpec {
  version: string;
  createdAt: string;
  figma: {
    fileName: string;
    pageName: string;
    selectedNodeName: string;
  };
  screen: {
    name: string;
    width: number;
    height: number;
    children: LeanNode[];
  };
  componentsUsed: Array<{
    codeComponent: string;
    codeFilePath: string;
    importType: "default" | "named";
    importName?: string;
    occurrences: number;
  }>;
  tokens: Array<{
    name: string;
    type: string;
    codeTokenName?: string;
    codeTokenPath?: string;
    usageCount: number;
  }>;
  assets: Array<{
    type: "icon" | "image" | "vector";
    name: string;
    path: string;
    format: "svg" | "png";
  }>;
  stats: {
    totalInstances: number;
    matched: number;
    unmatched: number;
    confidence: number;
    tokenCoverage: number;
  };
}

// ---------- UI ↔ main runtime messages --------------------------------------

export type UiToMain =
  | { type: "INIT" }
  | { type: "SCAN_SELECTION" }
  | { type: "AUTOFILL_MAPPINGS" }
  | { type: "BUILD_SPEC" }
  | { type: "GET_MAPPINGS" }
  | { type: "SAVE_MAPPING"; mapping: ComponentMapping }
  | { type: "DELETE_MAPPING"; id: string }
  | { type: "SET_CATALOGS"; components?: FEComponentCatalogItem[]; tokens?: FETokenCatalogItem[] }
  | { type: "SET_NODE_MARK"; nodeId: string; mark: AssetMark }
  | {
      type: "ZOOM_TO_NODE";
      nodeId: string;
      preserveSelection?: boolean;
      // When true, briefly select the node so Figma renders its purple
      // selection border, then restore the previous selection after a
      // short delay. Used by the tree-row eye button so the user can spot
      // the node in the canvas without losing their working selection.
      highlight?: boolean;
    }
  | { type: "ZOOM_TO_SELECTION" }
  | { type: "EXPAND_SELECTION" }
  | { type: "GET_FIGMA_COMPONENTS" }
  | { type: "CLOSE_PLUGIN" };

export type MainToUi =
  | {
      type: "INITIAL_STATE";
      mappings: ComponentMapping[];
      hasValidSelection: boolean;
      selection: { id: string; name: string; type: string } | null;
      catalogs: {
        components: FEComponentCatalogItem[];
        tokens: FETokenCatalogItem[];
      };
    }
  | {
      type: "SELECTION_STATE";
      hasValidSelection: boolean;
      selection: { id: string; name: string; type: string } | null;
    }
  | { type: "MAPPINGS_UPDATED"; mappings: ComponentMapping[] }
  | {
      type: "SCAN_RESULT";
      summary: {
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
          // Human-readable label for the unmatched card: the Component Set
          // parent name when available, so "Type=Normal, Breakpoint=Desktop"
          // surfaces as "Card header".
          displayName: string;
          mainComponentKey?: string;
        }>;
      };
    }
  | {
      type: "AUTOFILL_RESULT";
      suggestions: AutofillSuggestion[];
    }
  | {
      type: "SPEC_READY";
      spec: CompressedSpec;
      lean: LeanSpec;
      nwa: NwaBundleInfo;
    }
  | { type: "FIGMA_COMPONENTS"; names: string[] }
  | { type: "ERROR"; error: string }
  | { type: "PROGRESS"; stage: string };

export interface NwaBundleInfo {
  rootSlug: string;
  manifest: {
    version: string;
    exportDate: string;
    files: string[];
  };
  files: Record<string, { kind: "text"; content: string } | { kind: "binary"; base64: string }>;
  stats: {
    nodes: number;
    uniqueComponents: number;
    fills: number;
    strokes: number;
    effects: number;
    typography: number;
    icons: number;
    matchedComponents: number;
  };
}

export type VsCodeDesignSpecPayload = CompressedSpec & {
  nwa: NwaBundleInfo;
  lean: LeanSpec;
  componentMappings: ComponentMapping[];
};

export interface SelectionTreeNode {
  id: string;
  name: string;
  type: string;
  isInstance: boolean;
  matched: boolean; // INSTANCE has a component mapping
  mappingName?: string;
  figmaComponentKey?: string;
  figmaComponentName?: string;
  codeComponent?: string;
  codeFilePath?: string;
  importType?: "default" | "named";
  importName?: string;
  children?: SelectionTreeNode[];
}

export interface ReviewComponent {
  nodeId: string;
  name: string;
  type: string; // FRAME / INSTANCE / COMPONENT …
  codeComponent: string | null;
  codeFilePath: string | null;
}

export interface AutofillSuggestion {
  figmaName: string;
  figmaNodeId: string;
  figmaComponentKey?: string;
  candidates: Array<{
    codeComponent: string;
    codeFilePath: string;
    confidence: number;
    reason: string;
  }>;
}

// ---------- WebSocket protocol (Figma ↔ VS Code) ----------------------------

export type WsOut =
  | {
      type: "HELLO_FROM_FIGMA";
      pluginName: string;
      version: string;
      figmaFileName: string;
      figmaPageName: string;
    }
  | { type: "REQUEST_CATALOG"; requestId: string }
  | { type: "REQUEST_PROJECT_MAPPINGS"; requestId: string }
  | { type: "SEND_DESIGN_SPEC"; requestId: string; payload: VsCodeDesignSpecPayload }
  | { type: "SAVE_MAPPING"; mapping: ComponentMapping }
  | { type: "DELETE_MAPPING"; id: string }
  | {
      type: "VALIDATE_MAPPING";
      requestId: string;
      mapping: ComponentMapping;
    };

export type WsIn =
  | {
      type: "HELLO_FROM_VSCODE";
      projectName: string;
      framework?: string;
      componentCatalogAvailable: boolean;
      tokenCatalogAvailable: boolean;
      projectMappings?: ComponentMapping[];
      projectMappingsCount?: number;
    }
  | {
      type: "COMPONENT_CATALOG";
      requestId?: string;
      items: FEComponentCatalogItem[];
    }
  | {
      type: "TOKEN_CATALOG";
      requestId?: string;
      tokens: FETokenCatalogItem[];
    }
  | {
      type: "PROJECT_MAPPINGS";
      requestId?: string;
      mappings: ComponentMapping[];
    }
  | {
      type: "MAPPING_SUGGESTIONS";
      requestId?: string;
      suggestions: AutofillSuggestion[];
    }
  | {
      type: "SPEC_RECEIVED";
      requestId: string;
      ok: boolean;
      message?: string;
    };
