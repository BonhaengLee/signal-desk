// 사용법: PORT=4100 node src/server/main.ts
// 브라우저에서 http://localhost:4100/events?scenario=deploy-regression&speed=5

import { createSseServer } from './sse.ts';

const port = Number(process.env.PORT ?? 4100);
createSseServer().listen(port, () => {
  console.log(`SSE 서버: http://localhost:${port}/events?scenario=deploy-regression&seed=42&speed=1`);
});
