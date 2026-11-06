// Creates a workspace user or sets a user's password, directly in the database: the way to make
// the first admin (after that, admins manage users in the UI). The password is read without echo
// from the terminal, or from the first line of standard input when it is not a terminal; it is
// never taken from the command line, where it would land in shell history.
//
//   DATABASE_URL=... pnpm user create --email ada@example.com --name "Ada Lovelace" --roles admin
//   DATABASE_URL=... pnpm user set-password --email ada@example.com
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createUserBodySchema, emailSchema, newPasswordSchema } from '@specledger/core';
import type { UserRole } from '@specledger/core';
import { openDatabase } from '@specledger/db';
import type { Database } from '@specledger/db';

import { hashPassword } from '../auth/passwords.js';

export type UserCommand =
  | {
      readonly kind: 'create';
      readonly email: string;
      readonly displayName: string;
      readonly roles: readonly UserRole[];
    }
  | { readonly kind: 'set-password'; readonly email: string };

const USAGE = [
  'usage: pnpm user create --email <email> --name <display name> --roles <role,role>',
  '       pnpm user set-password --email <email>',
  'roles: engineer, reviewer, approver, admin',
].join('\n');

// The command, or a message saying what is wrong with the arguments.
export function parseUserCommand(args: readonly string[]): UserCommand | string {
  const [kind, ...rest] = args;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) return USAGE;
    flags.set(flag.slice(2), value);
  }
  if (kind === 'set-password') {
    const email = emailSchema.safeParse(flags.get('email'));
    return email.success && flags.size === 1 ? { kind, email: email.data } : USAGE;
  }
  if (kind === 'create') {
    const parsed = createUserBodySchema.omit({ password: true }).safeParse({
      email: flags.get('email'),
      displayName: flags.get('name'),
      roles: flags
        .get('roles')
        ?.split(',')
        .map((role) => role.trim()),
    });
    if (!parsed.success || flags.size !== 3) return USAGE;
    return { kind, ...parsed.data };
  }
  return USAGE;
}

// Runs a command; resolves to the line to print. Setting a password ends the user's sessions.
export async function runUserCommand(
  command: UserCommand,
  password: string,
  database: Database,
  now: Date = new Date(),
): Promise<string> {
  const checked = newPasswordSchema.safeParse(password);
  if (!checked.success) throw new Error('The password must be 12 to 200 characters.');
  const passwordHash = await hashPassword(checked.data);
  if (command.kind === 'create') {
    const user = await database.users.create({ ...command, passwordHash });
    if (user === null) throw new Error(`A user with the email ${command.email} exists.`);
    return `Created ${user.email} (${user.roles.join(', ')}).`;
  }
  const user = await database.users.getByEmail(command.email);
  if (user === null) throw new Error(`There is no user with the email ${command.email}.`);
  await database.transaction(async (tx) => {
    await tx.users.update(user.id, { passwordHash });
    await tx.sessions.revokeAllForUser(user.id, now);
  });
  return `Set a new password for ${user.email}; their sessions were ended.`;
}

function readPassword(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return new Promise((resolve) => {
      const lines = createInterface({ input });
      // Resolve first: close() fires the close handler synchronously.
      lines.once('line', (line) => {
        resolve(line);
        lines.close();
      });
      lines.once('close', () => {
        resolve('');
      });
    });
  }
  return new Promise((resolve) => {
    process.stdout.write('Password (not shown): ');
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let typed = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          process.stdout.write('\n');
          resolve(typed);
          return;
        }
        if (char === '\u0003') process.exit(130);
        typed = char === '\u007f' ? typed.slice(0, -1) : typed + char;
      }
    };
    input.on('data', onData);
  });
}

async function main(): Promise<number> {
  const command = parseUserCommand(process.argv.slice(2));
  if (typeof command === 'string') {
    process.stderr.write(`${command}\n`);
    return 2;
  }
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    process.stderr.write('Set DATABASE_URL to the database of the workspace.\n');
    return 2;
  }
  const password = await readPassword();
  const database = openDatabase({ connectionString, maxConnections: 2 });
  try {
    await database.migrate();
    process.stdout.write(`${await runUserCommand(command, password, database)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Failed.'}\n`);
    return 1;
  } finally {
    await database.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
