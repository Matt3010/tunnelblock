import dgram from "node:dgram";
import net from "node:net";

export type RawDnsResolver = (packet: Buffer) => Promise<Buffer>;

type RawDnsLogger = {
  info: (...args: any[]) => void;
  error: (...args: any[]) => void;
};

export function encodeTcpDnsFrame(message: Buffer): Buffer {
  if (message.length > 0xffff) {
    throw new Error("DNS-over-TCP message exceeds 65535 bytes");
  }

  const framed = Buffer.allocUnsafe(message.length + 2);
  framed.writeUInt16BE(message.length, 0);
  message.copy(framed, 2);
  return framed;
}

export function decodeTcpDnsFrames(buffer: Buffer): {
  messages: Buffer[];
  remainder: Buffer;
} {
  const messages: Buffer[] = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const length = buffer.readUInt16BE(offset);
    const end = offset + 2 + length;
    if (end > buffer.length) break;

    messages.push(Buffer.from(buffer.subarray(offset + 2, end)));
    offset = end;
  }

  return {
    messages,
    remainder: Buffer.from(buffer.subarray(offset)),
  };
}

function bindUdp(server: dgram.Socket, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.bind(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function listenTcp(server: net.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export async function startRawDnsServer(options: {
  host: string;
  port: number;
  resolve: RawDnsResolver;
  logger: RawDnsLogger;
}) {
  const { host, port, resolve, logger } = options;
  const udp = dgram.createSocket("udp4");

  udp.on("message", (packet, remote) => {
    void resolve(packet)
      .then(response => {
        udp.send(response, remote.port, remote.address, error => {
          if (error) {
            logger.error({ error, remote }, "raw-dns-udp-send-failed");
          }
        });
      })
      .catch(error => {
        logger.error({ error, remote }, "raw-dns-udp-resolution-failed");
      });
  });

  udp.on("error", error => {
    logger.error({ error }, "raw-dns-udp-error");
  });

  await bindUdp(udp, port, host);

  const tcp = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    let chain = Promise.resolve();

    socket.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      const decoded = decodeTcpDnsFrames(pending);
      pending = decoded.remainder;

      for (const message of decoded.messages) {
        chain = chain
          .then(async () => {
            const response = await resolve(message);
            if (!socket.destroyed) {
              socket.write(encodeTcpDnsFrame(response));
            }
          })
          .catch(error => {
            logger.error(
              { error, remoteAddress: socket.remoteAddress },
              "raw-dns-tcp-resolution-failed",
            );
            socket.destroy();
          });
      }
    });

    socket.on("error", error => {
      logger.error(
        { error, remoteAddress: socket.remoteAddress },
        "raw-dns-tcp-client-error",
      );
    });
  });

  tcp.on("error", error => {
    logger.error({ error }, "raw-dns-tcp-error");
  });

  try {
    await listenTcp(tcp, port, host);
  } catch (error) {
    udp.close();
    throw error;
  }

  logger.info({ host, port }, "raw-dns-listening");

  return {
    close: async () => {
      await Promise.all([
        new Promise<void>(resolveClose => udp.close(() => resolveClose())),
        new Promise<void>(resolveClose => tcp.close(() => resolveClose())),
      ]);
    },
  };
}
