export type SmartClassifierProvider = "typesafe" | "openrouter" | "openai-compatible";

export interface SmartSearchConfig {
  enabled: boolean;
  provider: SmartClassifierProvider;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  threshold: number;
  failOpen: boolean;
  enableTranscriptContext: boolean;
}

export const DEFAULT_SMART_CONFIG: SmartSearchConfig;

export type SmartQuestionName = "needs_external_lookup" | "involves_tool_or_config_claim";

export interface SmartQuestion {
  type: "bool";
  instructions: string;
  criteria: { true: string; false: string };
}

export const SMART_QUESTIONS: Record<SmartQuestionName, SmartQuestion>;

export interface KimiSessionContext {
  lastAssistantReply?: string;
  recentTools?: string[];
  prevUserText?: string;
}

export interface SmartClassifierState {
  user_prompt: string;
  has_images?: boolean;
  last_assistant_reply?: string;
  recent_tools?: string[];
  recent_user_context?: string;
}

export type SmartCredentials = Readonly<Record<string, string | undefined>>;

export interface SmartCredential {
  apiKey: string;
  ref: string;
  source: "local" | "env" | "none";
}

export type SmartFallbackReason = "disabled" | "empty-prompt" | "invalid-config" | "missing-credential" | "http-error" | "invalid-response" | "timeout" | "network-error";

export interface SmartClassifierResultBase {
  provider: SmartClassifierProvider;
  model: string;
  latencyMs: number;
  threshold: number;
}

export interface SmartClassifierSuccess extends SmartClassifierResultBase {
  ok: true;
  escalated: boolean;
  probabilities: Record<SmartQuestionName, number>;
}

export interface SmartClassifierFailure extends SmartClassifierResultBase {
  ok: false;
  escalated: false;
  fallbackReason: SmartFallbackReason;
  error: string;
}

export type SmartClassifierResult = SmartClassifierSuccess | SmartClassifierFailure;

export interface SmartFetchResponse {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}

export type SmartFetch = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  redirect: "error";
}) => Promise<SmartFetchResponse>;

export interface SmartClassifierInput {
  promptText: string;
  hasImages?: boolean;
  sessionId?: string;
  kimiCodeHome?: string;
  config?: { smartSearch?: Partial<SmartSearchConfig> };
  credentials?: SmartCredentials;
  env?: SmartCredentials;
  fetchImpl?: SmartFetch;
}

export interface SearchRouteConfig {
  enabled?: boolean;
  defaultProvider?: string;
  fallbackOrder?: readonly string[];
  providerBaseUrls?: Readonly<Record<string, string>>;
  providerEnabled?: Readonly<Record<string, boolean>>;
  customProviders?: ReadonlyArray<{
    id: string;
    enabled?: boolean;
    auth?: { mode: string };
  }>;
}

export interface UsableSearchRoutes {
  webProviders: string[];
  platforms: string[];
}

export function extractPromptInput(rawPrompt: unknown): { text: string; hasImages: boolean };
export function extractKimiSessionContext(sessionId: string | undefined, kimiCodeHome?: string, maxBytes?: number): KimiSessionContext;
export function buildSmartClassifierState(promptText: string, hasImages?: boolean, sessionContext?: KimiSessionContext): SmartClassifierState;
export function resolveSmartCredential(smartConfig?: Partial<SmartSearchConfig>, credentials?: SmartCredentials, env?: SmartCredentials): SmartCredential;
export function classifySmartTurn(input: SmartClassifierInput): Promise<SmartClassifierResult>;
export function usableSearchRoutes(cfg?: SearchRouteConfig, credentials?: SmartCredentials, _platformStates?: unknown, _kimiCodeHome?: string, env?: SmartCredentials): UsableSearchRoutes;
export function hasUsableSearchProvider(cfg?: SearchRouteConfig, credentials?: SmartCredentials, _platformStates?: unknown, _kimiCodeHome?: string, env?: SmartCredentials): boolean;
