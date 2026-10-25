import { createApp } from './app.js';

const host = process.env.PIVOICE_HOST ?? '127.0.0.1';
const port = Number(process.env.PIVOICE_PORT ?? 8095);

const { service, server, store } = await createApp();

if (store.get().capture.autostart) service.startCapture();
server.listen(port, host, () => {
  console.log(`pivoice listening on http://${host}:${port}`);
});

function shutdown() {
  service.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
