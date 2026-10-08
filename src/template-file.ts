// Moving custom templates around: the template file format (export and import) and copies.
// Pure (no DOM, no Yjs), so it is tested without a browser.

import { MAX_TEMPLATE_BYTES, toTemplateContent, type CustomTemplate } from './custom-templates';
import { DEFAULT_META, newId } from './store';
import { validateTemplate } from './template-store';
import { Builder, CATEGORIES, CUSTOM_CATEGORY, type BuilderHost, type TemplateDef } from './templates';

export const TEMPLATE_FILE_FORMAT = 'tabula-template';

/** The longest template name. */
export const NAME_MAX = 80;
const COPY_SUFFIX = ' (copy)';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** "<name> (copy)", with the name cut short so the whole stays within the name limit. */
export function copyName(name: string): string {
  return `${name.slice(0, NAME_MAX - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`;
}

/** The text of a template file: `{ format: 'tabula-template', version: 1, template }`. */
export function exportTemplateFile(t: CustomTemplate): string {
  return JSON.stringify({ format: TEMPLATE_FILE_FORMAT, version: 1, template: validateTemplate(t) }, null, 2);
}

/**
 * A template from the text of a template file, as a new template of this person: fresh id and dates, `userId` as the
 * author. Throws a readable Error when the text is not a template file this app can open. A category that is not one
 * of the built-in ones (or Custom) becomes Custom, since categories are not free text.
 */
export function parseTemplateFile(text: string, userId: string, now = Date.now()): CustomTemplate {
  if (text.length > MAX_TEMPLATE_BYTES * 2) throw new Error('This file is too large to be a template (at most 1 MB).');
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON, so it is not a template file.');
  }
  if (!isRecord(file) || file.format !== TEMPLATE_FILE_FORMAT) throw new Error('This is not a Tabula template file.');
  if (file.version !== 1) {
    throw new Error(typeof file.version === 'number' && file.version > 1
      ? 'This template file was made by a newer version of Tabula and cannot be opened here.'
      : 'This template file has an unknown format version.');
  }
  if (!isRecord(file.template)) throw new Error('This template file holds no template.');
  const raw = file.template;
  const known = typeof raw.category === 'string' && [...CATEGORIES, CUSTOM_CATEGORY].includes(raw.category);
  // The file's own id is only used in error messages; the template gets a fresh one.
  const t = validateTemplate({
    ...raw,
    id: typeof raw.id === 'string' && raw.id ? raw.id : 'template',
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    description: raw.description ?? '',
    ...(typeof raw.category === 'string' && !known ? { category: CUSTOM_CATEGORY } : {}),
  });
  return { ...t, id: newId() };
}

/** A copy of a saved template for `userId`: same content, a new id, and "<name> (copy)". */
export function duplicateTemplate(t: CustomTemplate, userId: string, now = Date.now()): CustomTemplate {
  const safe = validateTemplate(t);
  return {
    ...safe, content: structuredClone(safe.content), id: newId(), name: copyName(safe.name), createdBy: userId, createdAt: now, updatedAt: now,
  };
}

/** A built-in template as a saved one for `userId`, named "<name> (copy)" and in the same category. */
export function builtinToCustom(def: TemplateDef, userId: string, now = Date.now()): CustomTemplate {
  const host: BuilderHost = { user: { id: userId }, store: { getMeta: () => DEFAULT_META } };
  const b = new Builder(host, 0, 0);
  def.build(b);
  const fonts = { heading: DEFAULT_META.headingFont, body: DEFAULT_META.bodyFont };
  const content = toTemplateContent(b.objs, b.steps, { includeSteps: true, fonts });
  return {
    id: newId(), version: 1, name: copyName(def.name), category: def.category, description: def.description,
    // The builder leaves undefined fields behind; a JSON round trip drops them.
    content: JSON.parse(JSON.stringify(content)),
    createdBy: userId, createdAt: now, updatedAt: now,
  };
}
