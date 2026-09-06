import { startServer } from './index.js';

const port = Number(process.env.PORT) || 3005;
startServer(port)
  .then(() => console.log(`🚀 Control API running on http://localhost:${port}`))
  .catch((err) => {
    console.error('Failed to start Control API server:', err);
    process.exit(1);
  });
