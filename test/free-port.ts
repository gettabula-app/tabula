import net from 'node:net';

// A port for a relay that a test starts. Fixed ranges picked at random (18000 to 28900) overlapped between test files,
// and between runs on a machine that is also running other suites, and a relay that finds its port taken dies on
// start (TAB-180). The system hands out a port nothing holds, and this never hands the same one out twice in a process.
const handedOut = new Set<number>();

export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    if (!handedOut.has(port)) {
      handedOut.add(port);
      return port;
    }
  }
}
