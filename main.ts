// tiny-stack-vm-01 entry: runs every /input/<id>/program.bin (with its input.bin) on make.fun's tiny stack ISA v1
// (ISA.md; vm.mjs beside it is the rule) and writes /output/<id>/stdout.bin + /output/<id>/exit.txt.
// Node 22, stdlib only. Local run: MAKEFUN_INPUT_DIR=... MAKEFUN_OUTPUT_DIR=... node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STACK_MAX = 256;
const CALLS_MAX = 64;
const MEMORY_WORDS = 256;
const STEP_LIMIT = 1_000_000;
const OUTPUT_MAX = 65_536;

const TRAP = {
  UNDERFLOW: 2,
  OVERFLOW: 3,
  DIV_ZERO: 4,
  BAD_OPCODE: 5,
  MEMORY: 6,
  CALL_DEPTH: 7,
  RET_EMPTY: 8,
  PC: 9,
  STEPS: 10,
  OUTPUT: 11,
} as const;

// byte -> [immBytes, pops, pushes]; unknown bytes fall through to trap 5.
const OP_BY_BYTE = new Map<number, [number, number, number]>([
  [0x00, [0, 0, 0]], // HALT
  [0x01, [1, 0, 1]], // PUSH8
  [0x02, [4, 0, 1]], // PUSH32
  [0x03, [0, 1, 0]], // POP
  [0x04, [0, 1, 2]], // DUP
  [0x05, [0, 2, 2]], // SWAP
  [0x06, [0, 2, 3]], // OVER
  [0x07, [0, 3, 3]], // ROT
  [0x10, [0, 2, 1]], // ADD
  [0x11, [0, 2, 1]], // SUB
  [0x12, [0, 2, 1]], // MUL
  [0x13, [0, 2, 1]], // DIV
  [0x14, [0, 2, 1]], // MOD
  [0x15, [0, 2, 1]], // DIVU
  [0x16, [0, 2, 1]], // MODU
  [0x17, [0, 1, 1]], // NEG
  [0x18, [0, 2, 1]], // AND
  [0x19, [0, 2, 1]], // OR
  [0x1a, [0, 2, 1]], // XOR
  [0x1b, [0, 1, 1]], // NOT
  [0x1c, [0, 2, 1]], // SHL
  [0x1d, [0, 2, 1]], // SHR
  [0x1e, [0, 2, 1]], // SHRU
  [0x20, [0, 2, 1]], // EQ
  [0x21, [0, 2, 1]], // LT
  [0x22, [0, 2, 1]], // LTU
  [0x30, [2, 0, 0]], // JMP
  [0x31, [2, 1, 0]], // JZ
  [0x32, [2, 1, 0]], // JNZ
  [0x33, [2, 0, 0]], // CALL
  [0x34, [0, 0, 0]], // RET
  [0x40, [0, 1, 1]], // LOAD
  [0x41, [0, 2, 0]], // STORE
  [0x50, [0, 1, 0]], // PRINT
  [0x51, [0, 1, 0]], // PUTC
  [0x52, [0, 0, 1]], // IN
  [0x53, [0, 1, 0]], // EXIT
]);

function run(program: Uint8Array, input: Uint8Array): { stdout: Uint8Array; exit: number } {
  const n = program.length;
  const D = new Int32Array(STACK_MAX);
  let sp = 0;
  const C = new Int32Array(CALLS_MAX);
  let csp = 0;
  const M = new Int32Array(MEMORY_WORDS);
  const out = new Uint8Array(OUTPUT_MAX);
  let olen = 0;
  let inPos = 0;
  let pc = 0;
  let steps = 0;
  const done = (exit: number): { stdout: Uint8Array; exit: number } => ({
    stdout: out.slice(0, olen),
    exit,
  });
  const trap = (code: number) => done(code);

  for (;;) {
    if (steps === STEP_LIMIT) return trap(TRAP.STEPS);
    if (pc < 0 || pc >= n) return trap(TRAP.PC);
    const op = OP_BY_BYTE.get(program[pc]);
    if (op === undefined) return trap(TRAP.BAD_OPCODE);
    const [imm, pops, pushes] = op;
    if (pc + imm >= n) return trap(TRAP.PC);
    steps++;
    const next = pc + 1 + imm;
    if (sp < pops) return trap(TRAP.UNDERFLOW);
    if (sp - pops + pushes > STACK_MAX) return trap(TRAP.OVERFLOW);
    pc = next;
    switch (program[pc - 1 - imm]) {
      case 0x00: // HALT
        return done(0);
      case 0x01: // PUSH8 (sign-extended)
        D[sp++] = (program[next - 1] << 24) >> 24;
        break;
      case 0x02: // PUSH32 (little-endian, signed)
        D[sp++] = program[next - 4] | (program[next - 3] << 8) | (program[next - 2] << 16) | (program[next - 1] << 24);
        break;
      case 0x03: // POP
        sp--;
        break;
      case 0x04: // DUP
        D[sp] = D[sp - 1];
        sp++;
        break;
      case 0x05: { // SWAP
        const t = D[sp - 1];
        D[sp - 1] = D[sp - 2];
        D[sp - 2] = t;
        break;
      }
      case 0x06: // OVER
        D[sp] = D[sp - 2];
        sp++;
        break;
      case 0x07: { // ROT
        const a = D[sp - 3];
        D[sp - 3] = D[sp - 2];
        D[sp - 2] = D[sp - 1];
        D[sp - 1] = a;
        break;
      }
      case 0x17: // NEG (wraps)
        D[sp - 1] = -D[sp - 1] | 0;
        break;
      case 0x1b: // NOT
        D[sp - 1] = ~D[sp - 1];
        break;
      case 0x10: // ADD
      case 0x11: // SUB
      case 0x12: // MUL
      case 0x13: // DIV
      case 0x14: // MOD
      case 0x15: // DIVU
      case 0x16: // MODU
      case 0x18: // AND
      case 0x19: // OR
      case 0x1a: // XOR
      case 0x1c: // SHL
      case 0x1d: // SHR
      case 0x1e: // SHRU
      case 0x20: // EQ
      case 0x21: // LT
      case 0x22: { // LTU
        const b = D[sp - 1];
        const a = D[sp - 2];
        let r: number;
        switch (program[pc - 1]) {
          case 0x10: // ADD
            r = (a + b) | 0;
            break;
          case 0x11: // SUB
            r = (a - b) | 0;
            break;
          case 0x12: // MUL: low 32 bits of the exact product
            r = Math.imul(a, b);
            break;
          case 0x13: // DIV: toward zero; INT_MIN/-1 wraps
            if (b === 0) return trap(TRAP.DIV_ZERO);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14: // MOD: sign of a; x % -1 = 0
            if (b === 0) return trap(TRAP.DIV_ZERO);
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15: // DIVU: unsigned
            if (b === 0) return trap(TRAP.DIV_ZERO);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16: // MODU: unsigned
            if (b === 0) return trap(TRAP.DIV_ZERO);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x18: // AND
            r = a & b;
            break;
          case 0x19: // OR
            r = a | b;
            break;
          case 0x1a: // XOR
            r = a ^ b;
            break;
          case 0x1c: // SHL: only low 5 bits of count
            r = a << (b & 31);
            break;
          case 0x1d: // SHR: arithmetic
            r = a >> (b & 31);
            break;
          case 0x1e: // SHRU: logical
            r = (a >>> (b & 31)) | 0;
            break;
          case 0x20: // EQ
            r = a === b ? 1 : 0;
            break;
          case 0x21: // LT: signed
            r = a < b ? 1 : 0;
            break;
          default: // 0x22 LTU: unsigned
            r = a >>> 0 < b >>> 0 ? 1 : 0;
            break;
        }
        sp -= 2;
        D[sp++] = r;
        break;
      }
      case 0x30: // JMP
      case 0x31: // JZ
      case 0x32: { // JNZ
        const rel = ((program[next - 2] | (program[next - 1] << 8)) << 16) >> 16;
        let take = true;
        if (program[pc - 3] !== 0x30) {
          const v = D[--sp];
          take = program[pc - 3] === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = next + rel;
        break;
      }
      case 0x33: { // CALL: absolute unsigned target
        if (csp === CALLS_MAX) return trap(TRAP.CALL_DEPTH);
        C[csp++] = next;
        pc = program[next - 2] | (program[next - 1] << 8);
        break;
      }
      case 0x34: // RET
        if (csp === 0) return trap(TRAP.RET_EMPTY);
        pc = C[--csp];
        break;
      case 0x40: { // LOAD
        const addr = D[sp - 1];
        if (addr < 0 || addr >= MEMORY_WORDS) return trap(TRAP.MEMORY);
        D[sp - 1] = M[addr];
        break;
      }
      case 0x41: { // STORE
        const addr = D[sp - 1];
        const v = D[sp - 2];
        if (addr < 0 || addr >= MEMORY_WORDS) return trap(TRAP.MEMORY);
        sp -= 2;
        M[addr] = v;
        break;
      }
      case 0x50: { // PRINT: decimal, no padding, no newline
        const bytes = Buffer.from(String(D[sp - 1]), 'latin1');
        if (olen + bytes.length > OUTPUT_MAX) return trap(TRAP.OUTPUT);
        sp--;
        out.set(bytes, olen);
        olen += bytes.length;
        break;
      }
      case 0x51: // PUTC: v AND 255
        if (olen + 1 > OUTPUT_MAX) return trap(TRAP.OUTPUT);
        out[olen++] = D[--sp] & 255;
        break;
      case 0x52: // IN: next byte or -1 past the end
        D[sp++] = inPos < input.length ? input[inPos++] : -1;
        break;
      case 0x53: // EXIT: low byte
        return done(D[--sp] & 255);
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const dir = join(I, id);
  const program = readFileSync(join(dir, 'program.bin'));
  let input = new Uint8Array(0);
  try {
    input = readFileSync(join(dir, 'input.bin'));
  } catch {
    // no input.bin: IN reads an empty stream
  }
  const { stdout, exit } = run(program, input);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), stdout);
  writeFileSync(join(O, id, 'exit.txt'), `${exit}\n`);
}
