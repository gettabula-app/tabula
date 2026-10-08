// Board data model. Every object is stored as a flat Y.Map of these fields, so
// concurrent edits to different fields of one object merge cleanly and the same
// field resolves last-writer-wins.

export type Id = string;

export type ShapeKind =
  | 'rect' | 'rounded' | 'ellipse' | 'diamond' | 'triangle' | 'hexagon'
  | 'octagon' | 'parallelogram' | 'trapezoid' | 'star' | 'cylinder'
  | 'document' | 'terminator' | 'manual-input' | 'predefined'
  | 'pentagon' | 'cross' | 'heart' | 'cloud' | 'arrow-right' | 'arrow-left'
  | 'arrow-both' | 'chevron' | 'arrow-pentagon' | 'callout-rect' | 'callout-round'
  | 'delay' | 'merge' | 'off-page' | 'manual-operation' | 'display';

export type UmlType =
  | 'uml-class' | 'uml-actor' | 'uml-usecase' | 'uml-lifeline' | 'uml-note'
  | 'uml-package' | 'uml-state' | 'uml-initial' | 'uml-final' | 'uml-component';

export type ObjType = 'shape' | 'sticky' | 'text' | 'frame' | 'icon' | 'path' | 'connector' | UmlType;

export type Dash = 'solid' | 'dashed' | 'dotted';
export type Align = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'middle' | 'bottom';

export type Head =
  | 'none' | 'arrow' | 'open' | 'triangle' | 'diamond' | 'diamond-open'
  | 'circle' | 'bar' | 'crow-many' | 'crow-one';

export type Route = 'straight' | 'elbow' | 'curved';

export type UmlRelation =
  | 'association' | 'directed' | 'generalization' | 'realization' | 'dependency'
  | 'aggregation' | 'composition' | 'message' | 'async' | 'reply'
  | 'include' | 'extend' | 'transition';

export type Side = 'top' | 'right' | 'bottom' | 'left';

export type End =
  | { kind: 'free'; x: number; y: number }
  | { kind: 'bound'; id: Id; anchor: 'auto' | Side };

export interface StyleFields {
  fill: string;
  stroke: string;
  strokeWidth: number;
  dash: Dash;
  opacity: number;
  font: string;        // Fontshare slug, or 'system'
  fontWeight: number;
  fontSize: number;
  textColor: string;
  align: Align;
  valign: VAlign;
}

export interface Member {
  visibility: '+' | '-' | '#' | '~' | '';
  name: string;
  type: string;
  isStatic?: boolean;
  isAbstract?: boolean;
}

export interface BaseObj extends Partial<StyleFields> {
  id: Id;
  type: ObjType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: string;
  parent?: Id;
  locked?: boolean;
  createdBy?: string;
  updatedAt?: number;
  text?: string;
  // shape
  kind?: ShapeKind;
  // frame
  name?: string;
  // icon
  ref?: string;
  body?: string;
  viewBox?: [number, number, number, number];
  sticker?: boolean;
  // path
  points?: number[]; // flat [x0,y0,x1,y1,...] relative to x,y
  // uml-class
  stereotype?: string;
  attributes?: Member[];
  operations?: Member[];
  // facilitation
  privateStep?: Id;
}

export interface ConnectorObj {
  id: Id;
  type: 'connector';
  z: string;
  from: End;
  to: End;
  route: Route;
  startHead: Head;
  endHead: Head;
  relation?: UmlRelation;
  label?: string;
  stroke?: string;
  strokeWidth?: number;
  dash?: Dash;
  opacity?: number;
  createdBy?: string;
  updatedAt?: number;
  // unused geometry fields kept for uniform handling
  x?: number; y?: number; w?: number; h?: number; rotation?: number; parent?: Id; locked?: boolean;
}

export type Obj = BaseObj | ConnectorObj;

export const isConnector = (o: Obj | undefined): o is ConnectorObj => !!o && o.type === 'connector';
export const isBox = (o: Obj | undefined): o is BaseObj => !!o && o.type !== 'connector';

export type StepMode = 'write' | 'private-write' | 'cluster' | 'vote' | 'discuss' | 'poll';

export interface Step {
  id: Id;
  title: string;
  instructions: string;
  frameId?: Id;
  durationSec?: number;
  mode: StepMode;
  /** Dots each person may place; 0 = unlimited. Defaults to 3. */
  votesPerPerson?: number;
  /** Added with the one-click dot vote; removed from the flow when the session ends. */
  quick?: boolean;
  /** Set iff mode is 'poll'; the poll lives in the `polls` map (see docs/polls.md). */
  pollId?: Id;
}

export interface Timer {
  startedAt: number;
  durationMs: number;
  pausedAt?: number;
}

export interface Vote {
  itemId: Id;
  userId: string;
  stepId: Id;
}

export interface PollOption {
  id: Id;
  text: string;
}

export interface Poll {
  id: Id;
  question: string;
  options: PollOption[];
  multiple: boolean;
  anonymous: boolean;
  revealed: boolean;
  createdAt: number;
  createdBy: string;
  /** First time the flow moved onto the poll's step. The definition locks from here. */
  openedAt?: number;
  /** First time the flow moved off the step, or the session ended. Answers lock from here. */
  closedAt?: number;
}

export interface PollAnswer {
  pollId: Id;
  userId: string;
  optionIds: Id[];
  updatedAt: number;
  /** Named polls only. */
  name?: string;
  color?: string;
}

export type GridType = 'dots' | 'lines' | 'iso' | 'none';

export interface BoardMeta {
  name: string;
  schemaVersion: number;
  gridType: GridType;
  gridSize: number;
  snap: boolean;
  headingFont: string;
  bodyFont: string;
  /** Custom sticky colours added on this board, newest first; shared by everyone. */
  stickyColors: string[];
}

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export interface User { id: string; name: string; color: string }

export const SCHEMA_VERSION = 1;
