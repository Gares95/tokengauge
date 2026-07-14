import { render } from 'preact';
import { CockpitApp } from './CockpitApp';
import './cockpit.css';

function getRoot() {
  const existing = document.getElementById('root');
  if (existing) {
    return existing;
  }

  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  return root;
}

render(<CockpitApp />, getRoot());
