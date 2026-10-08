import { describe, expect, it } from 'vitest';
import { editColours } from '../src/editor';
import { CANVAS_INK } from '../src/palette';
import type { BaseObj, ConnectorObj } from '../src/types';

const umlClass = (extra: Partial<BaseObj> = {}) =>
  ({ id: 'c1', type: 'uml-class', z: 'a', x: 0, y: 0, w: 200, h: 160, text: 'Order', ...extra }) as BaseObj;

const connector = (extra: Partial<ConnectorObj> = {}) =>
  ({
    id: 'l1', type: 'connector', z: 'a', route: 'straight', startHead: 'none', endHead: 'arrow',
    from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 100, y: 0 }, label: 'uses', ...extra,
  }) as ConnectorObj;

describe('edit box colours', () => {
  it('keeps the white box and dark ink for a class with no colours of its own', () => {
    expect(editColours(umlClass(), 'class')).toEqual({ color: '', background: '' });
  });

  it("uses a class's custom fill and text colour", () => {
    expect(editColours(umlClass({ fill: '#1F3A5F', textColor: '#F4F1E8' }), 'class')).toEqual({ color: '#F4F1E8', background: '#1F3A5F' });
  });

  it('uses a custom fill alone and keeps the default ink', () => {
    expect(editColours(umlClass({ fill: '#FFE16B' }), 'class')).toEqual({ color: '', background: '#FFE16B' });
  });

  it('falls back to the white box when the fill is none', () => {
    expect(editColours(umlClass({ fill: 'none', textColor: '#B00020' }), 'class')).toEqual({ color: '#B00020', background: '' });
  });

  it("draws a connector label in the connector's custom colour", () => {
    expect(editColours(connector({ stroke: '#2F6FED' }), 'label')).toEqual({ color: '#2F6FED', background: '' });
  });

  it('keeps the dark ink for a connector in the default or no colour', () => {
    expect(editColours(connector(), 'label').color).toBe('');
    expect(editColours(connector({ stroke: CANVAS_INK }), 'label').color).toBe('');
    expect(editColours(connector({ stroke: 'none' }), 'label').color).toBe('');
  });
});
