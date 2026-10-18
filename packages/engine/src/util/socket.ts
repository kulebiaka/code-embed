import { connect, type Socket } from "node:net";

export function probeSocket(path: string, timeoutMs: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => fail(), timeoutMs);
    const fail = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(null);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", fail);
      resolve(socket);
    });
  });
}
