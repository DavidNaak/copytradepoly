#!/usr/bin/env node
import { Command } from 'commander';
import { setupAccountCommand } from './cli/setup';
import { copytradeCommand } from './cli/copytrade';
import { statusCommand } from './cli/status';
import dotenv from 'dotenv';

dotenv.config();

const program = new Command();

program
  .name('copytrader')
  .description('CLI copytrading bot for Polymarket')
  .version('1.0.0');

// Register commands
program.addCommand(setupAccountCommand);
program.addCommand(copytradeCommand);
program.addCommand(statusCommand);

program.parse(process.argv);
