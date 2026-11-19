import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AuthApp from './app/AuthApp';
import './app/globals.css';

createRoot(document.getElementById('root')!).render(<StrictMode><AuthApp /></StrictMode>);
