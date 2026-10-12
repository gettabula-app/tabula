import { describe, expect, it } from 'vitest';
import { Builder, TEMPLATES } from '../src/templates';
import type { BaseObj } from '../src/types';

// A built-in template that says how long it takes in its header ("about 40 minutes") must agree with the session bar, which adds
// up the steps' durations ("5 steps, about 33 minutes"). The steps are the truth.

const host = { user: { id: 'u1' }, store: { getMeta: () => ({ bodyFont: 'satoshi', headingFont: 'cabinet-grotesk' }) } };

describe('template header durations', () => {
  it.each(TEMPLATES.map((t) => [t.id, t]))('%s says the minutes its steps add up to', (_id, def) => {
    const b = new Builder(host, 0, 0);
    def.build(b);
    const texts = (b.objs as BaseObj[]).map((o) => String((o as { text?: unknown }).text ?? ''));
    expect(texts.some((t) => t.includes('{minutes}')), `${def.name}: an unfilled {minutes}`).toBe(false);
    const said = texts.map((t) => t.match(/about (\d+) minutes/)).find(Boolean);
    if (!said || !b.steps.length) return; // a template with no stated time, or no steps, has nothing to disagree with
    const total = Math.round(b.steps.reduce((sum, s) => sum + (s.durationSec ?? 0), 0) / 60);
    expect(Number(said[1]), `${def.name}: the header says ${said[1]}, the steps add up to ${total}`).toBe(total);
  });
});
