export interface AgentInfo {
  id: string | null;
  mainAgent: boolean;
  type: string | null;
  description: string | null;
  prompt: string | null;
  status: 'starting' | 'running' | 'done';
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  model: string | null;
  lastMessage: string | null;
  lastTool: string | null;
  lastToolAt: string | null;
  tools: Record<string, number>;
  toolEvents: number;
}

export interface Todo {
  id?: string;
  content: string;
  status: string;
  description?: string | null;
  activeForm?: string | null;
  blockedBy?: string[];
}

export interface SessionInfo {
  id: string;
  cwd: string | null;
  startedAt: string;
  lastPromptAt: string | null;
  lastActivity: string;
  state: 'active' | 'working' | 'idle' | 'ended';
  startSource: string | null;
  permissionMode: string | null;
  pmMode: boolean;
  mission: string | null;
  subModel: string | null;
  progress: { state: string; pct: number | null; note: string; updatedAt: string } | null;
  lastPrompt: string | null;
  lastResult: string | null;
  todos: Todo[];
  stats: { spawns: number; toolCalls: number; mainWrites: number; denies: number };
  env?: {
    model: string | null;
    branch: string | null;
    version: string | null;
    contextTokens: number | null;
    contextWindow?: number | null;
    usage: { in: number; cacheRead: number; out: number };
    usageApprox: boolean;
  } | null;
  agents: AgentInfo[];
}

export interface HookEvent {
  __ts: string;
  __hook: string;
  payload: any;
}

export interface DashState {
  generatedAt: string;
  sessions: SessionInfo[];
  events: HookEvent[];
}
