// Registered as the system's web browser for the packaged suite. The operating
// system's opener starts it with the address it was handed; it appends exactly
// that argument to the log named first, with the variables below as it received
// them, and exits successfully.
// Usage: node record-url.mjs <log> <address>

import { appendFileSync } from 'node:fs';

// What an AppImage's runtime, AppRun and GTK hook set for the app itself
// (#525). Their values are search paths and display settings, never secrets.
const IMAGE_VARIABLES = [
  'APPDIR',
  'APPIMAGE',
  'ARGV0',
  'OWD',
  'PATH',
  'LD_LIBRARY_PATH',
  'XDG_DATA_DIRS',
  'GSETTINGS_SCHEMA_DIR',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONDONTWRITEBYTECODE',
  'PERLLIB',
  'QT_PLUGIN_PATH',
  'GST_PLUGIN_SYSTEM_PATH',
  'GST_PLUGIN_SYSTEM_PATH_1_0',
  'GDK_BACKEND',
  'GDK_PIXBUF_MODULE_FILE',
  'GIO_EXTRA_MODULES',
  'GI_TYPELIB_PATH',
  'GTK_DATA_PREFIX',
  'GTK_EXE_PREFIX',
  'GTK_IM_MODULE_FILE',
  'GTK_PATH',
  'GTK_THEME',
];

const [log, address, ...rest] = process.argv.slice(2);
if (!log) process.exit(2);
const env = Object.fromEntries(
  IMAGE_VARIABLES.filter((key) => key in process.env).map((key) => [key, process.env[key]]),
);
appendFileSync(log, `${JSON.stringify({ at: Date.now(), address, extra: rest, env })}\n`);
