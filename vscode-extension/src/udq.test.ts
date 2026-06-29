import {
  UDQ_CONTROL_WORDS,
  UDQ_FUNCTIONS,
  isUdqControlWord,
  isUdqFunction,
} from './udq';

describe('udq vocabulary', () => {
  test('control words are the four UDQ commands', () => {
    expect(Object.keys(UDQ_CONTROL_WORDS).sort()).toEqual([
      'ASSIGN', 'DEFINE', 'UNITS', 'UPDATE',
    ]);
  });

  test('isUdqControlWord recognises only control words', () => {
    expect(isUdqControlWord('DEFINE')).toBe(true);
    expect(isUdqControlWord('ASSIGN')).toBe(true);
    expect(isUdqControlWord('SORTA')).toBe(false);
    expect(isUdqControlWord('toString')).toBe(false);
  });

  test('isUdqFunction recognises known functions only', () => {
    expect(isUdqFunction('SORTA')).toBe(true);
    expect(isUdqFunction('SUM')).toBe(true);
    expect(isUdqFunction('NINT')).toBe(true);
    expect(isUdqFunction('DEFINE')).toBe(false);
    expect(isUdqFunction('hasOwnProperty')).toBe(false);
  });

  test('every function has a signature and description', () => {
    for (const [name, fn] of Object.entries(UDQ_FUNCTIONS)) {
      expect(fn.signature).toContain(name);
      expect(fn.description.length).toBeGreaterThan(0);
    }
  });
});
