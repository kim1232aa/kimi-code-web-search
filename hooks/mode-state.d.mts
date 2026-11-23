export interface ModeDocument {
  globalMode: "auto" | "smart" | "required" | "off";
  activeSessionId?: string;
  sessions: Record<string, any>;
  updatedAt: number;
}

export function positiveInteger(value: unknown, name: string, maximum?: number): number | undefined;
export function webToolsDir(): string;
export function readModeState(file?: string): ModeDocument;
export function updateModeState<T extends ModeDocument = ModeDocument>(file: string, change: (document: T) => void): T;
export function effectiveMode(document: ModeDocument, sessionId: string): "auto" | "smart" | "required" | "off";
export function newTurn(document: ModeDocument, sessionId: string, options?: {
  required?: boolean;
  requiredEvidence?: "search" | "search-or-fetch";
  recognizeExternal?: boolean;
  exempted?: boolean;
  smartEscalated?: boolean;
  smartDecision?: any;
}): {
  turn: number;
  required: boolean;
  disabled: boolean;
  requiredEvidence: "search" | "search-or-fetch";
  recognizeExternal: boolean;
  exempted: boolean;
  smartEscalated: boolean;
  smartDecision?: any;
  webSearchCompleted: boolean;
  webSearchSucceeded: boolean;
  webFetchCompleted: boolean;
  webFetchSucceeded: boolean;
  externalWebCompleted: boolean;
  externalWebSucceeded?: boolean;
  externalSearchCompleted: boolean;
  externalSearchSucceeded?: boolean;
  correctionCount: number;
};
export function classifyOwnTool(name: string): "web_search" | "web_fetch" | undefined;
export function isMcpProxyToolName(name: string): boolean;
export function isExternalWebToolName(name: string): boolean;
export function isExternalWebToolCall(name: string, input?: Record<string, unknown>): boolean;
export function externalWebToolKind(name: string, input?: Record<string, unknown>): "search" | "fetch" | undefined;
export function hookPayload(): Promise<Record<string, any>>;
export function hookFailure(error: unknown): void;
