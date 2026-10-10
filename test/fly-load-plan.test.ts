import { describe, expect, it } from 'vitest';
import {
  FLY_LOAD_MAX_TOTAL_MINUTES,
  FLY_LOAD_SIZES,
  FLY_LOAD_USERS,
  evaluateFlyLoadPassRule,
  hasFlyLoadGoPhrase,
  makeFlyLoadGoPhrase,
  makeFlyLoadPlan,
} from '../scripts/lib/fly-load-plan.mjs';

describe('TAB-227 Fly capacity plan', () => {
  it('builds the size ladder, user steps, three-hour expiry and time cap as data', () => {
    const now = Date.UTC(2026, 9, 10, 12);
    const plan = makeFlyLoadPlan({ now, slug: 'tab227-load-test' });
    expect(FLY_LOAD_SIZES).toEqual([
      { id: 'shared-cpu-1x', machineSize: 'shared-cpu-1x', memoryMb: 512 },
      { id: 'performance-1x', machineSize: 'performance-1x', memoryMb: 1024 },
      { id: 'performance-2x', machineSize: 'performance-2x', memoryMb: 2048 },
    ]);
    expect(FLY_LOAD_USERS).toEqual([30, 60, 100]);
    expect(plan.sizes.map(({ id }) => id)).toEqual(FLY_LOAD_SIZES.map(({ id }) => id));
    expect(plan.userSteps).toEqual([30, 60, 100]);
    expect(plan.secondsPerStep).toBe(60);
    expect(plan.workspaceExpiresAt).toBe(now + 3 * 60 * 60 * 1000);
    expect(plan.maxTotalMinutes).toBe(FLY_LOAD_MAX_TOTAL_MINUTES);
    expect(plan.maxTotalMinutes).toBe(180);
    expect(plan.estimated).toMatchObject({ loadActivitySeconds: 540, joinBurstSeconds: 90, measuredMinutes: 10.5, maxMachineMinutes: 180 });
  });

  it('ties one exact go phrase to the printed slug', () => {
    const phrase = makeFlyLoadGoPhrase('tab227-load-test');
    expect(phrase).toBe('run the fly load test tab227-load-test');
    expect(hasFlyLoadGoPhrase(undefined, 'tab227-load-test')).toBe(false);
    expect(hasFlyLoadGoPhrase('run the fly load test wrong-slug', 'tab227-load-test')).toBe(false);
    expect(hasFlyLoadGoPhrase(`${phrase} `, 'tab227-load-test')).toBe(false);
    expect(hasFlyLoadGoPhrase(phrase, 'tab227-load-test')).toBe(true);
  });

  it('recommends the smallest size that passes the 100-user verdict and both machine limits', () => {
    const evaluation = evaluateFlyLoadPassRule([
      { sizeId: 'shared-cpu-1x', users: 100, loadClassVerdict: 'OK', cpuSustainedPct: 70, relayRssMb: 100 },
      { sizeId: 'performance-1x', users: 100, loadClassVerdict: 'OK', cpuSustainedPct: 69.9, relayRssMb: 716.7 },
      { sizeId: 'performance-2x', users: 100, loadClassVerdict: 'OK', cpuSustainedPct: 40, relayRssMb: 900 },
    ]);
    expect(evaluation.recommendation).toBe('performance-1x');
    expect(evaluation.checks.map(({ passed }) => passed)).toEqual([false, true, true]);
    expect(evaluateFlyLoadPassRule([]).recommendation).toBeNull();
    expect(evaluateFlyLoadPassRule([
      { sizeId: 'shared-cpu-1x', users: 100, loadClassVerdict: 'OK', cpuSustainedPct: 69, relayRssMb: 358.4 },
    ]).recommendation).toBeNull();
  });
});
