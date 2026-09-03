export interface AgentInfo {
  id: string | null;
  /** Bound claude agent_id; null while still an unbound spawn placeholder. */
  boundId?: string | null;
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
  /** Artifacts this session published (deduped by artifact id). */
  artifacts?: ArtifactInfo[];
  /** Background commands still running (Claude Code's "N shells"). */
  shells?: {
    id: string;
    command: string | null;
    description: string | null;
    agentId: string | null;
    startedAt: string;
    /** Output captured when the agent last read this shell (BashOutput). */
    lastOutput?: string;
    lastReadAt?: string;
  }[];
  /** Transcript history older than the first observed hook event (resume backfill). */
  replay?: ReplayEntry[];
  /** Composer availability: server opt-in + this session's channel bridge live. */
  channelConnected?: boolean;
  /** Open tool-approval prompts relayed from the session (permission relay). */
  permissionRequests?: PermissionRequest[];
  /** In-flight AskUserQuestion dialog (display-only; answered in the terminal). */
  openQuestion?: {
    questions: { question: string; header?: string; options?: { label: string; description?: string }[] }[];
    at: string;
  } | null;
}

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
  at: string;
}

export interface ReplayEntry {
  ts: string | null;
  kind: 'user' | 'text' | 'tool';
  text?: string;
  name?: string;
  input?: Record<string, string> | null;
}

export interface HookEvent {
  __ts: string;
  __hook: string;
  __seq?: number; // server-assigned monotonic id — stable list keys
  payload: any;
}

export interface DashState {
  generatedAt: string;
  sessions: SessionInfo[];
  events: HookEvent[];
  /** Server opt-in for the read-only session history browser. */
  historyEnabled?: boolean;
  /** Server opt-in for the read-only project file viewer. */
  filesEnabled?: boolean;
  /** Version of the plugin code the running server was started from. */
  version?: string | null;
}

export interface ArtifactInfo {
  id: string;
  url: string;
  title: string | null;
  favicon: string | null;
  description?: string | null;
  path: string | null;
  version?: string | null;
  capabilities?: string[];
  publishes: number;
  firstAt: string | null;
  lastAt: string | null;
  sessionId?: string;
  /** Recovered from a transcript (older publish) rather than observed live. */
  backfilled: boolean;
}

export interface ArtifactProject {
  cwd: string;
  artifacts: ArtifactInfo[];
}

export interface HistoryProject {
  dir: string;
  cwd: string;
  sessions: number;
  lastActive: string | null;
}

export interface HistorySession {
  id: string;
  size: number;
  mtime: string;
  startedAt: string | null;
  firstPrompt: string | null;
  /** Session currently known live to the dashboard. */
  live: boolean;
}
