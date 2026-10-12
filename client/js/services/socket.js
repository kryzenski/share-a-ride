import { wsUrl } from '../config.js';

export function connectSocket(onEvent) {
  let socket;
  let timer;
  let closed = false;

  function connect() {
    socket = new WebSocket(wsUrl());
    socket.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      if (!closed) timer = setTimeout(connect, 2000);
    };
  }

  connect();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    },
  };
}
