import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEvent, installFakeBrowser, type FakeBrowser } from './fake-dom';
import { numberField } from '../src/ui/controls';

let browser: FakeBrowser;
beforeEach(() => { browser = installFakeBrowser(); });
afterEach(() => { browser.uninstall(); });

const key = (k: string) => Object.assign(new FakeEvent('keydown'), { key: k, shiftKey: false });

function field(value = 400) {
  const log: string[] = [];
  const onCommit = vi.fn<(v: number) => void>((v) => log.push(`commit ${v}`));
  const input = numberField({
    label: 'Width', value, min: 1, max: 5000, step: 1, big: 10, onPreview: () => undefined, onCommit, onRevert: () => undefined,
  } as Parameters<typeof numberField>[0]) as unknown as { value: string; select: () => void; dispatchEvent: (e: FakeEvent) => boolean };
  input.select = () => undefined; // the fake element has no text selection
  return { input, onCommit, log };
}

describe('a number field commits a typed value once', () => {
  it('Enter followed by the change event the browser fires for the same text commits once (one undo step)', () => {
    const { input, onCommit } = field();
    input.value = '333';
    input.dispatchEvent(key('Enter'));
    input.dispatchEvent(new FakeEvent('change'));
    input.dispatchEvent(new FakeEvent('blur'));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(333);
  });

  it('typing the value it already has writes nothing', () => {
    const { input, onCommit } = field(400);
    input.value = '400';
    input.dispatchEvent(key('Enter'));
    input.dispatchEvent(new FakeEvent('change'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('a second, different value still commits', () => {
    const { input, onCommit } = field();
    input.value = '333';
    input.dispatchEvent(key('Enter'));
    input.dispatchEvent(new FakeEvent('change'));
    input.value = '350';
    input.dispatchEvent(key('Enter'));
    input.dispatchEvent(new FakeEvent('change'));
    expect(onCommit.mock.calls.map((c) => c[0])).toEqual([333, 350]);
  });

  it('a value typed and left with Tab (change, then blur) commits once', () => {
    const { input, onCommit } = field();
    input.value = '250';
    input.dispatchEvent(new FakeEvent('change'));
    input.dispatchEvent(new FakeEvent('blur'));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
