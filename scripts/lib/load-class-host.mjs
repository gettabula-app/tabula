/** @param {{ loadavg?: number[], cpus?: number }} input */
export function hostLoad({ loadavg = [], cpus = 0 } = {}) {
  const coreCount = Number.isFinite(cpus) && cpus > 0 ? cpus : 1;
  const load1 = Number.isFinite(loadavg[0]) && loadavg[0] >= 0 ? loadavg[0] : 0;
  const perCore = load1 / coreCount;
  const level = perCore < 0.5 ? 'quiet' : perCore <= 1 ? 'busy' : 'overloaded';
  return { load1, cpus: coreCount, perCore, busy: level !== 'quiet', level };
}

/** @param {{ load1: number, cpus: number, perCore: number, busy: boolean, level: string }} load @param {{ allowBusy?: boolean }} [options] */
export function hostLoadAdvice(load, { allowBusy = false } = {}) {
  if (load.level === 'quiet') return { proceed: true, lines: [] };

  if (load.level === 'busy') {
    return {
      proceed: true,
      lines: [`*** WARNING: host load average ${load.load1} on ${load.cpus} cores is busy; other work on this machine may distort latency. ***`],
    };
  }

  if (allowBusy) {
    return {
      proceed: true,
      lines: [`*** WARNING: proceeding with overloaded host load average ${load.load1} on ${load.cpus} cores; other work on this machine will distort latency. LOAD_CLASS_ALLOW_BUSY=1 is set. ***`],
    };
  }

  return {
    proceed: false,
    lines: [`*** REFUSED: host load average ${load.load1} on ${load.cpus} cores is overloaded; other work on this machine will distort latency. Set LOAD_CLASS_ALLOW_BUSY=1 to override. ***`],
  };
}
