// The module Web Worker that tokenises code (see code-highlight.ts). It answers every request with the same id, with lines or null.
import { createCodeTokenizer, type TokenizeRequest } from './code-tokenize';
import type { CodeLines } from './code-tokens';

export interface WorkerRequest extends TokenizeRequest { id: number }
export interface WorkerReply { id: number; lines: CodeLines | null }

const tokenizer = createCodeTokenizer();
const scope = self as unknown as { onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null; postMessage(m: WorkerReply): void };

scope.onmessage = async (e) => {
  const { id, ...req } = e.data;
  let lines: CodeLines | null = null;
  try {
    lines = await tokenizer.tokenize(req);
  } catch {
    lines = null;
  }
  scope.postMessage({ id, lines });
};
