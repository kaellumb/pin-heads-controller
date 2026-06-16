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
    this.onStatusChange?.(`connecting ${this.relayUrl}`);
    console.log("[ws] connect", this.relayUrl);
    this.ws = new WebSocket(this.relayUrl);

    this.ws.onopen = () => {
      console.log("[ws] open", this.relayUrl);
      this.onStatusChange?.("connected");
      if (this.savedCode) this.joinRoom();
    };

    this.ws.onerror = (event) => {
      console.log("[ws] error", this.relayUrl, event);
      this.onStatusChange?.(`relay error ${this.relayUrl}`);
    };

    this.ws.onclose = () => {
      console.log("[ws] close", this.relayUrl);
      this.onStatusChange?.(`reconnecting ${this.relayUrl}`);
      this.joined = false;
      this.onReset?.();
      setTimeout(() => this.connect(), 1500);
    };

    this.ws.onmessage = (e) => {
      console.log("[ws] message", e.data);
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
