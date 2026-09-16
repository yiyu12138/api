'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, '_site');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), out, { recursive: true });
fs.copyFileSync(path.join(root, 'demo', 'demo.js'), path.join(out, 'demo.js'));
fs.copyFileSync(path.join(root, 'demo', 'demo.css'), path.join(out, 'demo.css'));
fs.copyFileSync(path.join(root, 'server', 'providers.js'), path.join(out, 'providers.js'));

const htmlFile = path.join(out, 'index.html');
const html = fs.readFileSync(htmlFile, 'utf8')
  .replaceAll('href="/', 'href="./')
  .replaceAll('src="/', 'src="./')
  .replace('</head>', '<link rel="stylesheet" href="./demo.css">\n</head>')
  .replace(/(<script src="(?:\.\/)?app\.js)/, '<script src="./providers.js"></script>\n<script src="./demo.js"></script>\n$1');
if (!html.includes('./demo.js')) throw new Error('Failed to inject demo.js');
fs.writeFileSync(htmlFile, html);

const appFile = path.join(out, 'app.js');
fs.writeFileSync(appFile, fs.readFileSync(appFile, 'utf8')
  .replaceAll('href="/icons.svg#', 'href="./icons.svg#')
  .replaceAll('src="/favicon.svg"', 'src="./favicon.svg"'));
