import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SSE_SERVER = 'http://localhost:4100';

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  build: { outDir: '../../dist', emptyOutDir: true },
  // 개발 중에도 화면과 SSE 를 같은 출처로 부르도록 서버 요청을 넘긴다
  server: { port: 5180, proxy: { '/events': SSE_SERVER, '/scenarios': SSE_SERVER, '/investigations': SSE_SERVER, '/proposals': SSE_SERVER } },
});
