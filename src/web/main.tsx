import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

// /?bench 이면 목록 렌더링 측정 페이지를 띄운다. 본 화면 번들에는 포함하지 않는다
const Bench = lazy(() => import('./Bench.tsx').then((m) => ({ default: m.Bench })));
const isBench = new URLSearchParams(location.search).has('bench');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isBench ? (
      <Suspense fallback={null}>
        <Bench />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
