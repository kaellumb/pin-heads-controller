class ConnectionManager {
  constructor(relayUrl, { onMessage, onStatusChange, onReset } = {}) {
    this.relayUrl = relayUrl;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
    this.onReset = onReset;
    this.ws = null;
    this.joined = false;
    this.savedCode = "";
  }

  connect() {
    this.ws = new WebSocket(this.relayUrl);

    this.ws.onopen = () => {
      this.onStatusChange?.("connected");
      if (this.savedCode) this.joinRoom();
    };

    this.ws.onclose = () => {
      this.onStatusChange?.("reconnecting…");
      this.joined = false;
      this.onReset?.();
      setTimeout(() => this.connect(), 1500);
    };

    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      this.onMessage?.(msg);
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  joinRoom() {
    this.send({ type: "join_room", code: this.savedCode });
  }
}
