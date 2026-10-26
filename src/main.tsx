import { render } from 'preact';
import { App } from './ui/App';
import './styles.css';

// Просим iOS не вычищать IndexedDB при нехватке места.
navigator.storage?.persist?.().catch(() => undefined);

render(<App />, document.getElementById('app')!);
