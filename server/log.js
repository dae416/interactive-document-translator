// The server's console output also goes to a file, since the Windows scheduled task throws the
// console away: ~/.config/interactive-document-translator/server.log, beside the env file and outside the synced data
// folder. Kept to about 2 MB plus the one before it (server.log.1). LOG_FILE moves it; LOG_FILE=off
// turns it off. Another app of the same code (APP_ID, config.js) writes server-<APP_ID>.log beside
// it, wherever that is (LOG_FILE=/x/eng.log: /x/eng-<APP_ID>.log), so two apps never share one.
// Imported first, so it sees everything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { format } from 'node:util';

const MAX = 2 * 1024 * 1024;
const setting = process.env.LOG_FILE;
// (as config.js reads it; that module comes after this one)
const app = (process.env.APP_ID || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const { dir, name, ext } = path.parse(path.resolve(setting || path.join(os.homedir(), '.config', 'interactive-document-translator', 'server.log')));
const file = setting === 'off' ? null : path.join(dir, `${name}${app ? `-${app}` : ''}${ext}`);

// A log that can't be written must never stop the server. Owner-only: it may name books and
// errors from the API.
function append(line) {
  try {
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size || 0) > MAX) {
      try {
        fs.renameSync(file, `${file}.1`);
      } catch {
        fs.truncateSync(file, 0); // held open (a viewer on Windows): start over
      }
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch {
    // full disk, a locked file
  }
}

if (file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    for (const level of ['log', 'warn', 'error']) {
      const write = console[level];
      console[level] = (...args) => {
        write.apply(console, args);
        append(`${new Date().toISOString()} ${level === 'log' ? '' : `${level} `}${format(...args)}\n`);
      };
    }
    // A crash ends the process before anything else can say why.
    process.on('uncaughtExceptionMonitor', (err) => append(`${new Date().toISOString()} crash ${err?.stack || err}\n`));
  } catch {
    // no folder for it: the console alone
  }
}
