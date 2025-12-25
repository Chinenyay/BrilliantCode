export type TodoStatus = 'todo' | 'in_progress' | 'done';
export type TodoItem = { status: TodoStatus; content: string };
export type TodoCollection = Record<number, TodoItem>;

export type TodoReturn = {
  message: string;
  todos: TodoCollection;
  count: number;
  item?: { index: number } & TodoItem;
};

type SessionTodoState = {
  todos: Map<number, TodoItem>;
  nextIndex: number;
};

const sessionStores = new Map<string, SessionTodoState>();

const STATUS_ALIASES: Record<string, TodoStatus> = {
  todo: 'todo',
  'to-do': 'todo',
  backlog: 'todo',
  pending: 'todo',
  open: 'todo',

  in_progress: 'in_progress',
  'in progress': 'in_progress',
  progress: 'in_progress',
  doing: 'in_progress',
  working: 'in_progress',
  started: 'in_progress',
  wip: 'in_progress',
  active: 'in_progress',

  done: 'done',
  complete: 'done',
  completed: 'done',
  finished: 'done',
  shipped: 'done',
  resolved: 'done',
};

function normalizeSessionKey(sessionId: string | null | undefined): string {
  const key = typeof sessionId === 'string' ? sessionId.trim() : '';
  return key || '__default__';
}

function getSessionState(sessionId: string | null | undefined): SessionTodoState {
  const key = normalizeSessionKey(sessionId);
  let state = sessionStores.get(key);
  if (!state) {
    state = { todos: new Map(), nextIndex: 1 };
    sessionStores.set(key, state);
  }
  return state;
}

function clampStatus(input: string): TodoStatus | undefined {
  const key = String(input || '').trim().toLowerCase();
  return STATUS_ALIASES[key];
}

function cloneTodos(sessionId: string | null | undefined): TodoCollection {
  const state = getSessionState(sessionId);
  const out: TodoCollection = {};
  for (const [idx, item] of state.todos.entries()) {
    out[idx] = { status: item.status, content: item.content };
  }
  return out;
}

function requireContent(content: string): string {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('content must be a non-empty string');
  }
  return content.trim();
}

function requireIndex(index: number): number {
  if (!Number.isInteger(index) || index <= 0) {
    throw new Error('index must be a positive integer');
  }
  return index;
}

async function addTodo(sessionId: string | null | undefined, content: string): Promise<TodoReturn> {
  const clean = requireContent(content);
  const state = getSessionState(sessionId);

  const idx = state.nextIndex++;
  const item: TodoItem = { status: 'todo', content: clean };
  state.todos.set(idx, item);

  return {
    message: `Added todo #${idx}`,
    item: { index: idx, ...item },
    todos: cloneTodos(sessionId),
    count: state.todos.size,
  };
}

async function updateTodoContent(sessionId: string | null | undefined, index: number, content: string): Promise<TodoReturn> {
  const idx = requireIndex(index);
  const clean = requireContent(content);
  const state = getSessionState(sessionId);

  const existing = state.todos.get(idx);
  if (!existing) {
    throw new Error(`todo #${idx} does not exist`);
  }

  existing.content = clean;

  return {
    message: `Updated todo #${idx} content`,
    item: { index: idx, status: existing.status, content: existing.content },
    todos: cloneTodos(sessionId),
    count: state.todos.size,
  };
}

async function updateTodoStatus(sessionId: string | null | undefined, index: number, status: string): Promise<TodoReturn> {
  const idx = requireIndex(index);
  const normalized = clampStatus(status);
  if (!normalized) {
    throw new Error("status must be one of: 'todo', 'in_progress', 'done'");
  }

  const state = getSessionState(sessionId);
  const existing = state.todos.get(idx);
  if (!existing) {
    throw new Error(`todo #${idx} does not exist`);
  }

  existing.status = normalized;

  return {
    message: `Updated todo #${idx} status to ${normalized}`,
    item: { index: idx, status: existing.status, content: existing.content },
    todos: cloneTodos(sessionId),
    count: state.todos.size,
  };
}

async function clearTodos(sessionId: string | null | undefined): Promise<TodoReturn> {
  const state = getSessionState(sessionId);
  const priorCount = state.todos.size;
  state.todos.clear();
  state.nextIndex = 1;

  return {
    message: `Cleared ${priorCount} todo item(s)`,
    todos: cloneTodos(sessionId),
    count: 0,
  };
}

async function listTodos(sessionId: string | null | undefined): Promise<{ count: number; todos: TodoCollection }> {
  const state = getSessionState(sessionId);
  return { count: state.todos.size, todos: cloneTodos(sessionId) };
}

export {
  addTodo,
  updateTodoContent,
  updateTodoStatus,
  clearTodos,
  listTodos,
};
