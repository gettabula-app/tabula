// Test fixture: `node --require test/shift-clock.cjs` moves the wall clock of a child process by SHIFT_MS (Date.now and new Date()).
const off = Number(process.env.SHIFT_MS || 0);
const RealDate = Date;
class ShiftedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + off); else super(...a); }
  static now() { return RealDate.now() + off; }
}
globalThis.Date = ShiftedDate;
