import path from 'node:path';
import { config } from './config.js';
import { openDatabase } from './db.js';

console.log(`\nRunning database migrations...`);
const db = openDatabase(config.dbPath);
console.log(`Database schema verified at: ${path.resolve(config.dbPath)}`);
db.close();
console.log(`Migrations complete.\n`);
