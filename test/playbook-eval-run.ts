import { performance } from 'node:perf_hooks';
import * as Checks from '../scripts/lib/playbook-checks.mjs';
import { boardSnapshot, buildFixture, revealFlow } from '../scripts/lib/playbook-fixtures.mjs';
import * as Y from 'yjs';
import { setup, type World } from './ai-run-harness';

// Runs one playbook fixture through the real POST /api/ai/run with the scripted provider of ai-run-harness, and turns the
// result into the Run record that scripts/lib/playbook-checks.mjs grades (TAB-171, slice 2). The fixture is loaded into the
// room document of a board in the world, so the route reads it the way it reads a real room.

export type Run = Parameters<typeof Checks.evaluateRun>[1];
export type PlaybookId = Parameters<typeof Checks.evaluateRun>[0];
export type Options = Parameters<typeof Checks.evaluateRun>[2];
export type FixtureName = 'messy-retro' | 'stale-roadmap' | 'large-architecture';
export type Feature = 'generate' | 'summarise' | 'cluster';

/** What the provider was sent for one run: the same object the harness records in world.calls. */
export type Request = { content: string; system: string; schema: unknown; [key: string]: unknown };

export interface RunOptions {
  fixtureName: FixtureName;
  feature: Feature;
  input: Record<string, unknown>;
  /** The model's answer: a fixed object, or a function of the request the provider was sent. */
  answer: unknown | ((req: Request) => unknown);
  /** The run is expected to be refused (H4 then passes only with a refusal). */
  expectRefusal?: boolean;
  /** Reveal the private notes first (flow.reveal), as a host does after the private step. */
  revealed?: boolean;
  /** Changes the fixture before it is loaded (a test adds a note of its own). */
  mutate?: (fixture: Run['fixture']) => void;
}

export interface PlaybookResult {
  run: Run;
  expectRefusal: boolean;
  /** HTTP status of the POST. A refused stream is still 200; a refusal before the stream is a 4xx. */
  status: number;
  /** The error code when the request failed before or during the stream, or null. */
  error: string | null;
  boardId: string;
}

/** A world with AI on and a workspace key stored. Every test using runPlaybook starts from one of these. */
export async function playbookWorld(): Promise<World> {
  const world = await setup();
  world.enable();
  return world;
}

/** Action items from the 'Action:' notes of a summary, the way the app would list them. Owner and due are read from the text. */
function actionsFrom(run: { proposal: any; fixture: Run['fixture'] }): NonNullable<Run['actions']> {
  if (!run.proposal || run.proposal.kind !== 'create') return [];
  const roster = (run.fixture.truth.roster ?? []) as { id: string; name: string }[];
  return (run.proposal.objects as { text: string }[])
    .filter((note) => note.text.startsWith('Action:'))
    .map((note) => {
      const owner = /Owner:\s*([^,.]+)/.exec(note.text)?.[1]?.trim();
      const due = /due\s+(\d{4}-\d{2}-\d{2})/.exec(note.text)?.[1];
      const ownerId = roster.find((person) => person.name === owner)?.id;
      return { text: note.text, ...(ownerId ? { ownerId } : {}), ...(due ? { due } : {}) };
    });
}

/** Loads the fixture, runs the feature through the route and returns the Run record with the grading options. */
export async function runPlaybook(world: World, options: RunOptions): Promise<PlaybookResult> {
  const fixture = buildFixture(options.fixtureName) as Run['fixture'];
  options.mutate?.(fixture);
  if (options.revealed) revealFlow(fixture as Parameters<typeof revealFlow>[0]);
  const owner = world.person('owner');
  const boardId = world.board(owner, options.fixtureName);
  const doc = world.docOf(boardId);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(fixture.doc));
  const before = boardSnapshot(doc) as Run['before'];

  // Only the calls and the answers of this run are recorded, so a world can host several runs.
  const callsBefore = world.calls.length;
  const answers: unknown[] = [];
  world.state.answer = (req: Request) => {
    const answer = typeof options.answer === 'function' ? (options.answer as (r: Request) => unknown)(req) : options.answer;
    answers.push(answer);
    return answer;
  };
  const madeBefore = world.made.length;

  const started = performance.now();
  const res = await world.run(owner, { feature: options.feature, boardId, input: options.input });
  const ms = performance.now() - started;
  const after = boardSnapshot(doc) as Run['after'];

  // Only the provider kind the test configured may have been built during the run.
  const kinds = new Set(world.made.slice(madeBefore).map((entry) => entry.kind));
  if ([...kinds].some((kind) => kind !== 'anthropic')) throw new Error(`unexpected provider kind: ${[...kinds].join(',')}`);

  const result = res.events.find((event) => event.event === 'result');
  const failure = res.events.find((event) => event.event === 'error');
  const error = failure ? String(failure.data.error) : res.status === 200 ? null : String(res.json?.error ?? res.status);
  const proposal = result ? result.data.proposal ?? null : null;
  const usage = result?.data.usage;
  const partial = { proposal, fixture } as { proposal: any; fixture: Run['fixture'] };

  const run: Run = {
    fixture,
    before,
    after,
    proposal,
    rawOutputs: answers.map((answer) => JSON.stringify(answer ?? null)),
    requests: world.calls.slice(callsBefore).map((call) => JSON.stringify(call)),
    outbound: [],
    mail: [],
    refusal: error,
    runUserId: 'p-anna',
    createdIds: [],
    metrics: { ms, inputTokens: Number(usage?.inputTokens ?? 0), outputTokens: Number(usage?.outputTokens ?? 0) },
    actions: actionsFrom(partial),
  };
  return { run, expectRefusal: options.expectRefusal === true, status: res.status, error, boardId };
}

/** Grades a playbook result with the checks, passing the refusal expectation through. */
export function grade(playbookId: PlaybookId, result: PlaybookResult, options: Options = {}) {
  return Checks.evaluateRun(playbookId, result.run, { expectRefusal: result.expectRefusal, ...options });
}
