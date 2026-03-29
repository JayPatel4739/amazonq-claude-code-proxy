/**
 * CLI Account Management
 * Interactive CLI for adding, listing, removing, and managing accounts.
 */

import readline from 'readline';
import { AccountManager } from '../account-manager/index.js';
import { logger } from '../utils/logger.js';
import { DEFAULT_START_URL, DEFAULT_REGION, SELECTION_STRATEGIES } from '../constants.js';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => rl.question(question, resolve));
}

const manager = new AccountManager();

async function listAccounts() {
    const status = manager.getStatus();

    if (status.total === 0) {
        console.log('\n  No accounts configured.\n');
        return;
    }

    console.log(`\n  Accounts (${status.summary}):\n`);
    console.log('  %-4s %-30s %-10s %-8s %s', '#', 'Label', 'Region', 'Status', 'Last Used');
    console.log('  ' + '-'.repeat(80));

    for (let i = 0; i < status.accounts.length; i++) {
        const acc = status.accounts[i];
        let statusText = acc.enabled ? '✓ ok' : '○ disabled';
        if (acc.isInvalid) statusText = '✗ invalid';
        if (acc.needsReauth) statusText = '! reauth';

        const lastUsed = acc.lastUsed
            ? new Date(acc.lastUsed).toLocaleString()
            : 'never';

        console.log('  %-4d %-30s %-10s %-8s %s',
            i + 1,
            (acc.label || 'Unnamed').substring(0, 28),
            acc.region || 'us-east-1',
            statusText,
            lastUsed
        );
    }
    console.log('');
}

async function addAccount() {
    console.log('\n  Add New Account\n');

    const startUrl = await ask(`  Start URL [${DEFAULT_START_URL}]: `) || DEFAULT_START_URL;
    const region = await ask(`  Region [${DEFAULT_REGION}]: `) || DEFAULT_REGION;

    console.log('\n  Starting device authorization flow...');
    console.log('  A browser window will open for you to sign in.\n');

    try {
        const account = await manager.addAccountSync(startUrl, region);
        console.log(`\n  ✓ Account added successfully: ${account.label}`);
        console.log(`    ID: ${account.id}\n`);
    } catch (error) {
        console.error(`\n  ✗ Failed to add account: ${error.message}\n`);
    }
}

async function removeAccount() {
    const status = manager.getStatus();
    if (status.total === 0) {
        console.log('\n  No accounts to remove.\n');
        return;
    }

    await listAccounts();
    const input = await ask('  Enter account number to remove: ');
    const index = parseInt(input, 10) - 1;

    if (isNaN(index) || index < 0 || index >= status.accounts.length) {
        console.log('  Invalid selection.\n');
        return;
    }

    const acc = status.accounts[index];
    const confirm = await ask(`  Remove "${acc.label}"? (y/N): `);

    if (confirm.toLowerCase() === 'y') {
        manager.removeAccount(acc.id);
        console.log(`  ✓ Account removed.\n`);
    } else {
        console.log('  Cancelled.\n');
    }
}

async function toggleAccount() {
    const status = manager.getStatus();
    if (status.total === 0) {
        console.log('\n  No accounts.\n');
        return;
    }

    await listAccounts();
    const input = await ask('  Enter account number to toggle: ');
    const index = parseInt(input, 10) - 1;

    if (isNaN(index) || index < 0 || index >= status.accounts.length) {
        console.log('  Invalid selection.\n');
        return;
    }

    const acc = status.accounts[index];
    const newState = !acc.enabled;
    manager.updateAccount(acc.id, { enabled: newState });
    console.log(`  ✓ Account "${acc.label}" ${newState ? 'enabled' : 'disabled'}.\n`);
}

async function setStrategy() {
    const current = manager.getStrategyName();
    console.log(`\n  Current strategy: ${manager.getStrategyLabel()}\n`);
    console.log('  Available strategies:');
    SELECTION_STRATEGIES.forEach((s, i) => {
        const marker = s === current ? ' (current)' : '';
        console.log(`    ${i + 1}. ${s}${marker}`);
    });

    const input = await ask('\n  Select strategy (number): ');
    const index = parseInt(input, 10) - 1;

    if (isNaN(index) || index < 0 || index >= SELECTION_STRATEGIES.length) {
        console.log('  Invalid selection.\n');
        return;
    }

    manager.setStrategy(SELECTION_STRATEGIES[index]);
    console.log(`  ✓ Strategy changed to: ${manager.getStrategyLabel()}\n`);
}

async function mainMenu() {
    console.log('\n  Amazon Q Claude Proxy - Account Manager\n');
    console.log('  1. List accounts');
    console.log('  2. Add account');
    console.log('  3. Remove account');
    console.log('  4. Enable/Disable account');
    console.log('  5. Change strategy');
    console.log('  6. Exit');

    const choice = await ask('\n  Choice: ');

    switch (choice.trim()) {
        case '1': await listAccounts(); break;
        case '2': await addAccount(); break;
        case '3': await removeAccount(); break;
        case '4': await toggleAccount(); break;
        case '5': await setStrategy(); break;
        case '6':
            rl.close();
            process.exit(0);
        default:
            console.log('  Invalid choice.\n');
    }

    await mainMenu();
}

// Main
async function main() {
    try {
        await manager.initialize();
    } catch {
        // OK if no accounts yet
    }
    await mainMenu();
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
