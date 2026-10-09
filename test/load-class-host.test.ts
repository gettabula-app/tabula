import { describe, expect, it } from 'vitest';
import { hostLoad, hostLoadAdvice } from '../scripts/lib/load-class-host.mjs';

describe('class load host guard', () => {
  it('classifies quiet load below half a core and stays silent', () => {
    const load = hostLoad({ loadavg: [1.99, 1.5, 1], cpus: 4 });
    expect(load).toEqual({ load1: 1.99, cpus: 4, perCore: 1.99 / 4, busy: false, level: 'quiet' });
    expect(hostLoadAdvice(load)).toEqual({ proceed: true, lines: [] });
  });

  it('warns but proceeds from half to one load per core', () => {
    const load = hostLoad({ loadavg: [2, 0, 0], cpus: 4 });
    const advice = hostLoadAdvice(load);
    expect(load.level).toBe('busy');
    expect(load.busy).toBe(true);
    expect(hostLoad({ loadavg: [4, 0, 0], cpus: 4 }).level).toBe('busy');
    expect(advice.proceed).toBe(true);
    expect(advice.lines).toHaveLength(1);
    expect(advice.lines[0]).toContain('other work on this machine may distort latency');
  });

  it('refuses overloaded load with details and the override name', () => {
    const load = hostLoad({ loadavg: [11, 0, 0], cpus: 10 });
    const advice = hostLoadAdvice(load);
    expect(load.level).toBe('overloaded');
    expect(advice.proceed).toBe(false);
    expect(advice.lines.join('\n')).toContain('load average 11 on 10 cores');
    expect(advice.lines.join('\n')).toContain('other work on this machine will distort latency');
    expect(advice.lines.join('\n')).toContain('LOAD_CLASS_ALLOW_BUSY=1');
  });

  it('allows an overloaded host when explicitly overridden and still warns', () => {
    const load = hostLoad({ loadavg: [11, 0, 0], cpus: 10 });
    const advice = hostLoadAdvice(load, { allowBusy: true });
    expect(advice.proceed).toBe(true);
    expect(advice.lines.join('\n')).toContain('overloaded host load average 11 on 10 cores');
  });

  it('guards zero cores by using one effective core', () => {
    expect(hostLoad({ loadavg: [2, 0, 0], cpus: 0 })).toEqual({
      load1: 2,
      cpus: 1,
      perCore: 2,
      busy: true,
      level: 'overloaded',
    });
  });

  it('treats Windows zero load averages as quiet', () => {
    const load = hostLoad({ loadavg: [0, 0, 0], cpus: 12 });
    expect(load).toEqual({ load1: 0, cpus: 12, perCore: 0, busy: false, level: 'quiet' });
    expect(hostLoadAdvice(load)).toEqual({ proceed: true, lines: [] });
  });
});
