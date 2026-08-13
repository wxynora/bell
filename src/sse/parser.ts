export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export interface SseParserHandlers {
  onEvent(event: SseEvent): void;
  onComment?(comment: string): void;
}

export class SseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseParseError";
  }
}

export class SseParser {
  readonly #decoder = new TextDecoder();
  readonly #handlers: SseParserHandlers;
  readonly #maxBufferedBytes: number;
  #buffer = "";
  #eventType = "";
  #dataLines: string[] = [];
  #lastEventId: string | undefined;
  #currentEventBytes = 0;

  constructor(handlers: SseParserHandlers, maxBufferedBytes: number) {
    this.#handlers = handlers;
    this.#maxBufferedBytes = maxBufferedBytes;
  }

  push(chunk: Uint8Array): void {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    this.#drainLines(false);
    this.#assertWithinLimit(Buffer.byteLength(this.#buffer, "utf8"));
  }

  finish(): void {
    this.#buffer += this.#decoder.decode();
    this.#drainLines(true);
  }

  #drainLines(final: boolean): void {
    while (this.#buffer.length > 0) {
      const lineEnd = this.#findLineEnd(final);
      if (lineEnd === -1) {
        if (final) {
          this.#processLine(this.#buffer, 0);
          this.#buffer = "";
        }
        return;
      }
      const line = this.#buffer.slice(0, lineEnd);
      const separatorLength =
        this.#buffer[lineEnd] === "\r" && this.#buffer[lineEnd + 1] === "\n" ? 2 : 1;
      this.#buffer = this.#buffer.slice(lineEnd + separatorLength);
      this.#processLine(line, separatorLength);
    }
  }

  #findLineEnd(final: boolean): number {
    for (let index = 0; index < this.#buffer.length; index += 1) {
      const character = this.#buffer[index];
      if (character === "\n") return index;
      if (character === "\r") {
        if (index === this.#buffer.length - 1 && !final) return -1;
        return index;
      }
    }
    return -1;
  }

  #processLine(line: string, separatorBytes: number): void {
    this.#currentEventBytes += Buffer.byteLength(line, "utf8") + separatorBytes;
    this.#assertWithinLimit(0);
    if (line === "") {
      this.#dispatch();
      this.#currentEventBytes = 0;
      return;
    }
    if (line.startsWith(":")) {
      this.#handlers.onComment?.(line.startsWith(": ") ? line.slice(2) : line.slice(1));
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.#eventType = value;
    else if (field === "data") this.#dataLines.push(value);
    else if (field === "id" && !value.includes("\0")) this.#lastEventId = value;
  }

  #dispatch(): void {
    if (this.#dataLines.length === 0) {
      this.#eventType = "";
      return;
    }
    const event: SseEvent = {
      event: this.#eventType || "message",
      data: this.#dataLines.join("\n"),
      ...(this.#lastEventId === undefined ? {} : { id: this.#lastEventId }),
    };
    this.#handlers.onEvent(event);
    this.#eventType = "";
    this.#dataLines = [];
  }

  #assertWithinLimit(extraBytes: number): void {
    if (this.#currentEventBytes + extraBytes > this.#maxBufferedBytes) {
      throw new SseParseError("SSE event exceeded configured buffer limit");
    }
  }
}
