export interface CodeLang { readonly id: string; readonly label: string; readonly shiki: string | null }
export const CODE_LANGS: ReadonlyArray<CodeLang>;
export const CODE_LANG_IDS: ReadonlyArray<string>;
export const DEFAULT_CODE_LANG: string;
export const COMMON_CODE_LANGS: ReadonlyArray<string>;
export const MAX_CODE_CHARS: number;
export const MAX_CODE_TITLE: number;
export function normaliseCodeLang(value: unknown): string | null;
export function isCodeLang(value: unknown): value is string;
export function codeLangLabel(id: string): string;
