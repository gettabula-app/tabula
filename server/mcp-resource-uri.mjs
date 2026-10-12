import { TOKEN_BOARD_ID_RE } from './tokens.mjs';

export function parseBoardResourceUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('board://')) return null;
  const boardId = uri.slice('board://'.length);
  return TOKEN_BOARD_ID_RE.test(boardId) ? boardId : null;
}
