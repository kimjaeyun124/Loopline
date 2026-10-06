export type ProviderId = 'openai' | 'anthropic' | 'api';

export type ModelChoice = {
  key: string;
  provider: ProviderId;
  providerLabel: string;
  id: string;
  label: string;
  accountId?: string;
  connectionId?: string;
  connectionName?: string;
  accountName?: string;
  decisionOnly?: boolean;
  supportedReasoningEfforts?: string[];
};

export type ChatRole = 'user' | 'assistant';

export type RoundStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type LoopRound = {
  number: number;
  modelLabel: string;
  status: RoundStatus;
  promptPreview: string;
  activity?: string;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  modelLabel?: string;
  providerLabel?: string;
  rounds?: LoopRound[];
  loopEnabled?: boolean;
  error?: string;
  loopLimitReached?: boolean;
  stopped?: boolean;
};

export type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  codexThreadId?: string;
  codexAccountId?: string;
};

export type ConnectionSummary = {
  connectedModels: number;
  connectedProviders: string[];
};

export type StoredPreferences = {
  apiBaseUrl?: string;
  selectedModelKey?: string;
  loopEnabled?: boolean;
  maxRounds?: number;
};
