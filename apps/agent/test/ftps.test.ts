import { constants } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "../src/fetchers/ftps.ts";

const fixture = (name: string) => readFileSync(new URL(`fixtures/tls/${name}`, import.meta.url));

/**
 * Just enough of the printer's vsftpd (implicit TLS 1.2, session-ID cache, `require_ssl_reuse`) to list a
 * directory: data connections that don't resume the control connection's TLS session get a 522.
 */
function fakePrinter() {
  const sessions = new Map<string, Buffer>();
  const dataControl = new Map<string, tls.TLSSocket>();
  const server = tls.createServer({
    key: fixture("key.pem"),
    cert: fixture("cert.pem"),
    maxVersion: "TLSv1.2",
    secureOptions: constants.SSL_OP_NO_TICKET,
  });
  server.on("newSession", (id: Buffer, data: Buffer, done: () => void) => {
    sessions.set(id.toString("hex"), data);
    done();
  });
  server.on("resumeSession", (id: Buffer, done: (err: Error | null, data: Buffer | null) => void) =>
    done(null, sessions.get(id.toString("hex")) ?? null),
  );
  server.on("secureConnection", (socket) => {
    socket.on("error", () => {});
    const control = dataControl.get(`${socket.remotePort}`);
    if (control) {
      if (!socket.isSessionReused()) {
        control.write("522 SSL connection failed: session reuse required\r\n");
        socket.destroy();
        return;
      }
      socket.end("-rw-r--r-- 1 0 0 10 Jan 01 00:00 Bracket set.gcode.3mf\r\n", () =>
        control.write("226 Directory send OK.\r\n"),
      );
      return;
    }
    socket.write("220 (vsFTPd 3.0.5)\r\n");
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
        const cmd = line.split(" ")[0];
        if (cmd === "USER") socket.write("331 Please specify the password.\r\n");
        else if (cmd === "PASS") socket.write("230 Login successful.\r\n");
        else if (cmd === "EPSV") {
          const passive = net.createServer((raw) => {
            dataControl.set(`${raw.remotePort}`, socket);
            server.emit("connection", raw);
          });
          passive.listen(0, "127.0.0.1", () => {
            const { port } = passive.address() as net.AddressInfo;
            socket.write(`229 Entering Extended Passive Mode (|||${port}|)\r\n`);
          });
        } else if (cmd === "LIST") socket.write("150 Here comes the directory listing.\r\n");
        else if (cmd === "QUIT") socket.end("221 Goodbye.\r\n");
        else socket.write("200 OK.\r\n");
      }
    });
  });
  return server;
}

describe("ftps", () => {
  const server = fakePrinter();
  let port = 0;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => {
    server.close();
  });

  it("resumes the TLS session on data connections, as the printer requires", async () => {
    const printer = { serial: "SN", name: "H2D", host: "127.0.0.1", accessCode: "12345678" };
    const client = await connect(printer, port);
    try {
      const list = await client.list("/");
      expect(list.map((f) => f.name)).toEqual(["Bracket set.gcode.3mf"]);
    } finally {
      client.close();
    }
  });
});
