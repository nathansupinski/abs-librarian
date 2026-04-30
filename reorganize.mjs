#!/usr/bin/env node
import { runCLI } from './src/cli.mjs';
runCLI(process.argv).catch(err => { console.error('Fatal:', err); process.exit(1); });
