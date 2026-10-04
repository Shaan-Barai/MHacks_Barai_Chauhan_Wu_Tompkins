import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { DemoDataset } from '../contracts/demo.js';
import App from './App.js';
import './styles.css';

function Preview() {
  const [dataset, setDataset] = useState<DemoDataset | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    fetch('/demo-data.json', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Readings unavailable');
      const data = await response.json();
      if (data.schemaVersion !== 1 || data.source !== 'synthetic_ui_fixture' || !Array.isArray(data.services) || !data.window?.end || !data.hall?.name) throw new Error('Invalid demo records');
      setDataset(data);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt]);
  if (error) return <main className="loading"><h1>Scrap Saver</h1><p>We could not load the plate readings.</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></main>;
  if (!dataset) return <main className="loading"><h1>Scrap Saver</h1><p role="status">Loading plate readings...</p></main>;
  return <App dataset={dataset} />;
}

createRoot(document.getElementById('root')!).render(<Preview />);
