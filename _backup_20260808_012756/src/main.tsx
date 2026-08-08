import { createRoot } from 'react-dom/client';

import App from './App';
import { installGlobalDiagnostics } from '@/lib/diagnostics';

import './index.css';

// Must run before the app mounts so no early error slips past uncaptured.
installGlobalDiagnostics();

createRoot(document.getElementById('root')!).render(<App />);
