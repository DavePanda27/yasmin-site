import { mkdir, copyFile, cp } from 'node:fs/promises';
// Only public files are staged. Source, database, secrets and repository stay private.
await mkdir('.site', { recursive: true });
for (const file of ['index.html', '404.html', 'robots.txt', 'booking.js', 'booking.css']) {
  await copyFile(file, `.site/${file}`);
}
await cp('assets', '.site/assets', { recursive: true });

