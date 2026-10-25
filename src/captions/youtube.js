import { YoutubeLiveCaptionSender } from 'lcyt';

/**
 * YouTube caption delivery through the live-captions-yt core (`lcyt` on npm).
 * Captions go out in order, one at a time, stamped with the audio time plus the
 * configured delay so they match the video that YouTube receives.
 */
export class YouTubeCaptions {
  #streamKey;
  #delayMs;
  #createSender;
  #sender = null;
  #chain = Promise.resolve();
  #stats = { sent: 0, failed: 0, lastError: null };

  constructor({ streamKey = null, delayMs = 0, createSender = (opts) => new YoutubeLiveCaptionSender(opts) } = {}) {
    this.#streamKey = streamKey;
    this.#delayMs = delayMs;
    this.#createSender = createSender;
  }

  start() {
    if (!this.#streamKey) throw new Error('YouTube stream key is not set');
    if (this.#sender) return;
    this.#sender = this.#createSender({ streamKey: this.#streamKey });
    this.#sender.start();
  }

  stop() {
    this.#sender?.end();
    this.#sender = null;
  }

  push(event) {
    const sender = this.#sender;
    if (!sender) return;
    this.#chain = this.#chain.then(async () => {
      try {
        await sender.send(event.text, event.startMs + this.#delayMs);
        this.#stats.sent++;
      } catch (err) {
        this.#stats.failed++;
        this.#stats.lastError = this.#redact(err.message);
      }
    });
  }

  status() {
    return { configured: Boolean(this.#streamKey), running: this.#sender !== null, ...this.#stats, delayMs: this.#delayMs };
  }

  // The ingestion URL carries the stream key; keep it out of status and logs.
  #redact(message) {
    return this.#streamKey ? message.split(this.#streamKey).join('***') : message;
  }
}
