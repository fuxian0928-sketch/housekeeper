import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DesktopCompanion } from './features/companion/DesktopCompanion';
import './styles.css';
import './polish.css';
import './workspace.css';
import './features/companion/companion.css';
import './glass.css';

const isCompanionSurface = new URLSearchParams(window.location.search).get('surface') === 'companion';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isCompanionSurface ? <DesktopCompanion /> : <App />}
  </StrictMode>
);
