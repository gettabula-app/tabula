/** UI-local mirror of docs/tracker-architecture.md §12. Repoint to tracker-data types when that layer lands. */
export type StateCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

export type TicketLinkRecord =
  | {
      id: string;
      kind: 'pr';
      provider: 'github';
      repo: string;
      number: number;
      title: string;
      state: 'draft' | 'open' | 'merged' | 'closed';
      url: string;
      author: { login: string; name?: string; avatarUrl?: string };
      branch?: string;
      at: string;
    }
  | {
      id: string;
      kind: 'commit';
      provider: 'github';
      repo: string;
      sha: string;
      title: string;
      url: string;
      author: { login: string; name?: string; avatarUrl?: string };
      branch?: string;
      at: string;
    }
  | { id: string; kind: 'card'; boardId: string; kanbanId: string; cardId: string; at: string };

export type Ticket = {
  id: string;
  key: string;
  trackerId: string;
  title: string;
  description: string;
  state: { id: string; key: string; name: string; category: StateCategory };
  priority: 'none' | 'urgent' | 'high' | 'medium' | 'low';
  assignee: null | { userId: string; name: string };
  creator: { type: 'user' | 'mcp_token' | 'integration' | 'system'; id: string | null; name: string };
  labels: Array<{ id: string; name: string; color: string | null }>;
  project: null | { id: string; name: string };
  milestone: null | { id: string; name: string; due: string | null };
  estimate: number | null;
  due: string | null;
  parent: null | string;
  relations: Array<{ kind: 'blocks' | 'blocked_by' | 'relates_to' | 'duplicates' | 'duplicated_by'; key: string }>;
  links: TicketLinkRecord[];
  aliases: string[];
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  updatedSeq: number;
};
