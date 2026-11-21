import { describe, expect, it } from 'vitest';
import { MAX_EGRESS_EVENTS, isIpAddress, parseTrace } from './trace.js';

// Lines in the exact shape gVisor's strace writes (captured from runsc release-20261109.0).
const P = 'I1114 02:07:19.833280       1 strace.go:606] [   3:   3] node';
const exit = (call: string, ret: string): string => `${P} X ${call} = ${ret} (11.276µs)`;
const enter = (call: string): string => `${P} E ${call}`;
const ENETUNREACH = '-1 errno=101 (network is unreachable)';
const ENOENT = '-1 errno=2 (no such file or directory)';
const EROFS = '-1 errno=30 (read-only file system)';
const EACCES = '-1 errno=13 (permission denied)';
const EAGAIN = '-1 errno=11 (resource temporarily unavailable)';
const OK = '3 (0x3)';

const opts = { sensitivePaths: ['/host/credential', '/host/evidence'] };
const parse = (...lines: string[]) => parseTrace(lines.join('\n'), opts);

const connect = (family: string, addr: string, port = 443) =>
  `connect(0x14 socket:[3], 0x7f00 {Family: ${family}, Addr: ${addr}, Port: ${port}}, 0x10)`;
const openat = (path: string, flags: string) =>
  `openat(AT_FDCWD /, 0x7ecc2080ed3f ${path}, ${flags}, 0o666)`;

describe('parseTrace: egress', () => {
  it('counts IPv4 and IPv6 connects to remote addresses, failed or not', () => {
    const t = parse(
      exit(connect('AF_INET', '1.1.1.1'), ENETUNREACH),
      exit(connect('AF_INET6', '2606:4700:4700::1111'), ENETUNREACH),
      exit(connect('AF_INET', '172.17.0.1', 8080), '0 (0x0)'),
    );
    expect(t.egressAttempts).toBe(3);
  });

  it('counts unconnected UDP sends with a destination address', () => {
    const t = parse(
      exit(
        'sendto(0x15 socket:[4], 0x7f00 "affidavit", 0x9, 0x0, 0x7f10 {Family: AF_INET, Addr: 1.1.1.1, Port: 53}, 0x10)',
        ENETUNREACH,
      ),
    );
    expect(t.egressAttempts).toBe(1);
  });

  it('ignores loopback and unix sockets', () => {
    const t = parse(
      exit(connect('AF_INET', '127.0.0.1'), OK),
      exit(connect('AF_INET6', '::1'), OK),
      exit('connect(0x3 socket:[1], 0x7f00 {Family: AF_UNIX, Addr: "/run/x.sock"}, 0x6e)', ENOENT),
    );
    expect(t.egressAttempts).toBe(0);
  });

  it("counts a DNS query to Docker's embedded resolver as egress, though it is on loopback", () => {
    const local = { sensitivePaths: [], localNetworks: ['172.18.0.0/16'] };
    const t = parseTrace(
      [
        exit(
          'sendto(0x15 socket:[4], 0x7f00 "q", 0x1, 0x0, 0x7f10 {Family: AF_INET, Addr: 127.0.0.11, Port: 53}, 0x10)',
          '1 (0x1)',
        ),
        exit(connect('AF_INET', '127.0.0.11', 53), OK),
        exit(connect('AF_INET6', '::ffff:127.0.0.11', 53), OK),
        exit(connect('AF_INET', '127.0.0.1', 53), OK),
      ].join('\n'),
      local,
    );
    expect(t.egressAttempts).toBe(3);
  });

  it('does not count connects inside the case network, but counts everything else', () => {
    const local = { sensitivePaths: [], localNetworks: ['172.18.0.0/16'] };
    const t = parseTrace(
      [
        exit(connect('AF_INET', '172.18.0.2', 4000), OK),
        exit(connect('AF_INET6', '::ffff:172.18.0.2', 4000), OK),
        exit(connect('AF_INET', '172.17.0.1', 8080), ENETUNREACH),
        exit(connect('AF_INET', '172.19.0.2', 4000), ENETUNREACH),
        exit(connect('AF_INET6', '::ffff:1.1.1.1'), ENETUNREACH),
        exit(connect('AF_INET6', 'fd00::2'), ENETUNREACH),
      ].join('\n'),
      local,
    );
    expect(t.egressAttempts).toBe(4);
  });

  it('only counts exit lines, so one attempt is not counted twice', () => {
    const call = connect('AF_INET', '1.1.1.1');
    expect(parse(enter(call), exit(call, ENETUNREACH)).egressAttempts).toBe(1);
  });
});

describe('parseTrace: filesystem', () => {
  it('counts writes refused by a read-only or permission check', () => {
    const t = parse(
      exit(openat('/etc/x', 'O_WRONLY|O_CREAT|O_TRUNC'), EROFS),
      exit(openat('/home/node/x', 'O_WRONLY|O_CREAT|O_TRUNC'), EACCES),
      exit('mkdirat(AT_FDCWD /, 0x7f00 /usr/x, 0o777)', EROFS),
      exit('unlinkat(AT_FDCWD /, 0x7f00 /etc/passwd, 0x0)', EACCES),
    );
    expect(t.deniedWrites).toBe(4);
    expect(t.deniedReads).toBe(0);
  });

  it('does not count successful writes or ordinary missing files', () => {
    const t = parse(
      exit(openat('/scratch/x', 'O_WRONLY|O_CREAT|O_TRUNC'), OK),
      exit(openat('/usr/lib/locale/missing', 'O_RDONLY|O_CLOEXEC'), ENOENT),
    );
    expect(t.deniedWrites).toBe(0);
    expect(t.deniedReads).toBe(0);
  });

  it('counts a refused read', () => {
    expect(parse(exit(openat('/root/.ssh/id_rsa', 'O_RDONLY'), EACCES)).deniedReads).toBe(1);
  });

  it('counts any failed attempt on a sensitive host path, even ENOENT', () => {
    const t = parse(
      exit(openat('/host/credential', 'O_RDONLY|O_CLOEXEC'), ENOENT),
      exit(openat('/host/evidence/exhibit.bin', 'O_RDONLY|O_CLOEXEC'), ENOENT),
      exit(openat('/host/evidence/forged.bin', 'O_WRONLY|O_CREAT|O_TRUNC'), ENOENT),
    );
    expect(t.deniedReads).toBe(2);
    expect(t.deniedWrites).toBe(1);
  });

  it('matches sensitive paths by directory, not by prefix text', () => {
    expect(parse(exit(openat('/host/evidence-other', 'O_RDONLY'), ENOENT)).deniedReads).toBe(0);
  });

  it('treats creat as a write', () => {
    expect(parse(exit('creat(0x7f00 /etc/x, 0o644)', EROFS)).deniedWrites).toBe(1);
  });
});

describe('parseTrace: processes', () => {
  it('flags a fork refused with EAGAIN as hitting the pids limit', () => {
    expect(parse(exit('clone(CLONE_VM|0x11, 0x0, 0x0, 0x0, 0x0)', EAGAIN)).pidsLimitHit).toBe(true);
    expect(parse(exit('clone3(0x7f00, 0x58)', EAGAIN)).pidsLimitHit).toBe(true);
  });

  it('flags the warning gVisor logs when the host pids limit refuses it a stub process', () => {
    const t = parse(
      'W1114 08:36:13.721036       1 task_image.go:150] Failed to create new memory manager: createStub: failed to get clone',
    );
    expect(t.pidsLimitHit).toBe(true);
    expect(t.tampered).toBe(false);
  });

  it('does not take that warning from a line without gVisor log prefix', () => {
    expect(
      parse('x W1114 08:36:13.721036 1 task_image.go:150] Failed to create new memory manager')
        .pidsLimitHit,
    ).toBe(false);
  });

  it('does not flag successful forks', () => {
    expect(parse(exit('clone(CLONE_VM|0x11, 0x0, 0x0, 0x0, 0x0)', '2 (0x2)')).pidsLimitHit).toBe(
      false,
    );
  });
});

describe('parseTrace: egress log', () => {
  it('lists each attempt with what gVisor rendered, never the command name', () => {
    const local = { sensitivePaths: [], localNetworks: ['172.18.0.0/16'] };
    const t = parseTrace(
      [
        exit(connect('AF_INET', '1.1.1.1'), ENETUNREACH),
        exit(connect('AF_INET', '172.18.0.2', 4000), OK),
        exit(connect('AF_INET6', '2606:4700:4700::1111', 80), ENETUNREACH),
        exit(
          'sendto(0x15 socket:[4], 0x7f00 "q", 0x1, 0x0, 0x7f10 {Family: AF_INET, Addr: 127.0.0.11, Port: 53}, 0x10)',
          '1 (0x1)',
        ),
      ].join('\n'),
      local,
    );
    expect(t.egressAttempts).toBe(3);
    expect(t.egress).toEqual([
      {
        syscall: 'connect',
        family: 'ipv4',
        address: '1.1.1.1',
        port: 443,
        outcome: 'blocked',
        errno: 101,
        dns: false,
      },
      {
        syscall: 'connect',
        family: 'ipv6',
        address: '2606:4700:4700::1111',
        port: 80,
        outcome: 'blocked',
        errno: 101,
        dns: false,
      },
      {
        syscall: 'sendto',
        family: 'ipv4',
        address: '127.0.0.11',
        port: 53,
        outcome: 'sent',
        errno: null,
        dns: true,
      },
    ]);
    expect(JSON.stringify(t.egress)).not.toContain('node');
  });

  it(`keeps the first ${MAX_EGRESS_EVENTS} and still counts every attempt`, () => {
    const lines = Array.from({ length: MAX_EGRESS_EVENTS + 7 }, (_, i) =>
      exit(connect('AF_INET', `10.0.0.${i}`), ENETUNREACH),
    );
    const t = parse(...lines);
    expect(t.egressAttempts).toBe(MAX_EGRESS_EVENTS + 7);
    expect(t.egress).toHaveLength(MAX_EGRESS_EVENTS);
    expect(t.egress[0]?.address).toBe('10.0.0.0');
  });

  it('counts but does not list an address that is not an IP address', () => {
    const t = parse(exit(connect('AF_INET6', 'zz::not-an-ip'), ENETUNREACH));
    expect(t.egressAttempts).toBe(1);
    expect(t.egress).toEqual([]);
  });
});

describe('isIpAddress', () => {
  it.each([
    '1.1.1.1',
    '0.0.0.0',
    '255.255.255.255',
    '::1',
    '::',
    '2606:4700:4700::1111',
    '::ffff:127.0.0.11',
    '1:2:3:4:5:6:7:8',
    'fe80::1:2',
  ])('accepts %s', (a) => expect(isIpAddress(a)).toBe(true));
  it.each([
    '256.1.1.1',
    '1.1.1',
    '01.1.1.1',
    '1::2::3',
    '1:2:3:4:5:6:7:8:9',
    '12345::',
    'zz::1',
    '::ffff:1.2.3',
    'x',
    '',
  ])('refuses %s', (a) => expect(isIpAddress(a)).toBe(false));
});

describe('parseTrace: robustness', () => {
  it('ignores lines without gVisor log prefix, so jailed output cannot forge attempts', () => {
    const forged = `[   3:   3] node X ${connect('AF_INET', '1.1.1.1')} = ${ENETUNREACH}`;
    const t = parse(forged, `junk ${exit(connect('AF_INET', '1.1.1.1'), ENETUNREACH)}`);
    expect(t).toEqual({
      egressAttempts: 0,
      egress: [],
      deniedReads: 0,
      deniedWrites: 0,
      pidsLimitHit: false,
      syscalls: 0,
      tampered: false,
    });
  });

  it('counts recognised exit lines so an empty trace can be detected', () => {
    expect(parse('').syscalls).toBe(0);
    expect(parse(exit(openat('/etc/hosts', 'O_RDONLY'), OK)).syscalls).toBe(1);
  });

  it('accepts a clean trace with gVisor multi-line messages that are not syscall lines', () => {
    const t = parse(
      'I1114 08:27:05.312915       1 boot.go:224] Spec:',
      '{',
      '  "ociVersion": "1.3.0"',
      '}',
      enter(connect('AF_INET', '1.1.1.1')),
      exit(connect('AF_INET', '1.1.1.1'), ENETUNREACH),
    );
    expect(t.tampered).toBe(false);
    expect(t.egressAttempts).toBe(1);
  });

  it('reads a path argument that contains spaces', () => {
    expect(parse(exit(openat('/host/evidence/a b.bin', 'O_RDONLY'), ENOENT)).deniedReads).toBe(1);
  });
});

// Both attacks below were reproduced against runsc release-20261109.0: gVisor prints the command
// name and path arguments without escaping them.
describe('parseTrace: tampering by the jailed process', () => {
  const PREFIX = 'I1114 02:07:19.833280       1 strace.go:606] [   3:   3] ';

  it('flags a command name with a space, which would otherwise hide a connect', () => {
    const t = parse(`${PREFIX}a b X ${connect('AF_INET', '9.9.9.9')} = ${ENETUNREACH} (11.391µs)`);
    expect(t.tampered).toBe(true);
  });

  it('flags a command name with a newline', () => {
    const t = parse(
      `${PREFIX}a b`,
      `c X ${connect('AF_INET', '9.9.9.9')} = ${ENETUNREACH} (11.391µs)`,
    );
    expect(t.tampered).toBe(true);
  });

  it('flags a path with a newline that splits a syscall line', () => {
    const t = parse(
      `${P} E open(0x7eed0af87e78 /etc/a`,
      exit(connect('AF_INET', '6.6.6.6'), ENETUNREACH),
      '", O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0o666)',
    );
    expect(t.tampered).toBe(true);
  });

  it('flags a path built to complete the line it splits', () => {
    const t = parse(
      `${P} X open(0x7eed0af87e78 /a, O_RDONLY, 0o0) = 3 (0x3) (1µs)`,
      ', O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0o666) = -1 errno=30 (read-only file system) (2µs)',
    );
    expect(t.tampered).toBe(true);
  });

  it('flags a syscall exit line that does not parse', () => {
    expect(parse(`${P} X connect(0x14`).tampered).toBe(true);
    expect(parse(`${P} Q connect(0x14)`).tampered).toBe(true);
  });

  it('flags an empty command name', () => {
    const t = parse(`${PREFIX} X ${connect('AF_INET', '9.9.9.9')} = ${ENETUNREACH} (1µs)`);
    expect(t.tampered).toBe(true);
  });

  it('does not flag entry lines or a normal trace', () => {
    const t = parse(
      enter(openat('/etc/hosts', 'O_RDONLY')),
      exit(openat('/etc/hosts', 'O_RDONLY'), OK),
    );
    expect(t.tampered).toBe(false);
  });
});
