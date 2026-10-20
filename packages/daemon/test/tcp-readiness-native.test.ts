import net, { type AddressInfo } from "node:net";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";

// The TCP probe opens a real socket in-process. The exec function is a spy that must never run,
// so the probe works on hosts without `nc` (many Linux installs) and never forks a shell.
function adapter() {
  const exec = vi.fn(async () => { throw new Error("probeTcp must not shell out"); });
  return { exec, adapter: new ComposeServicesAdapter(exec) };
}

async function withListener<T>(host: string, run: (port: number, connections: () => number) => Promise<T>): Promise<T> {
  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.end(); });
  server.listen(0, host);
  await once(server, "listening");
  try {
    return await run((server.address() as AddressInfo).port, () => connections);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe.skipIf(process.platform === "win32")("TCP service readiness", () => {
  it.each(["127.0.0.1", "::1"])("probes an owned %s listener without an external nc", async host => {
    const { exec, adapter: a } = adapter();
    await withListener(host, async (port, connections) => {
      const target = `${host.includes(":") ? `[${host}]` : host}:${port}`;
      expect(await a.probeTcp(target, 1000)).toBe(true);
      await vi.waitFor(() => expect(connections()).toBe(1));
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports a closed port as not ready", async () => {
    const { exec, adapter: a } = adapter();
    // Take a free port, then release it, so nothing is listening there.
    const port = await withListener("127.0.0.1", async p => p);
    expect(await a.probeTcp(`127.0.0.1:${port}`, 1000)).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "127.0.0.1:", ":5432", "127.0.0.1:http", "127.0.0.1:0", "127.0.0.1:65536", "::1:5432"])(
    "refuses the malformed target %j without probing",
    async target => {
      const { exec, adapter: a } = adapter();
      expect(await a.probeTcp(target, 1000)).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    },
  );
});
