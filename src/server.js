import { createApp } from './app.js';

const server = createApp();
server.listen(3000, '127.0.0.1', () => {
  console.log('Errand web: http://127.0.0.1:3000 (no services connected)');
});
