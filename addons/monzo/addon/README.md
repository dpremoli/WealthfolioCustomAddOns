# Monzo Bank Integration Addon

Automatically sync transactions from your Monzo bank account into Wealthfolio.

## Features

- **One-click Monzo authentication** via OAuth
- **Automatic transaction sync** into your Wealthfolio accounts
- **Smart filtering** - skips pending transactions and pot transfers
- **Duplicate detection** - won't import the same transaction twice
- **Account mapping** - link your Monzo accounts to Wealthfolio accounts

## Installation

1. Ensure the Monzo proxy is running (see parent README)
2. In Wealthfolio, go to Settings > Addons
3. Upload the `monzo-addon.zip` file
4. Enable the addon

## Quick Start

1. **Configure Proxy URL**
   - Go to Monzo Sync > Settings
   - Enter your proxy URL (e.g., `http://172.29.201.179:8001`)
   - Click "Save" then "Test Connection"

2. **Connect Your Monzo Account**
   - Click "Connect Monzo Account"
   - Authenticate with your Monzo credentials

3. **Start Syncing**
   - Go to the main dashboard
   - Click "Sync Now"

## Permissions

- **Accounts**: Map Monzo accounts to Wealthfolio accounts
- **Activities**: Import transactions as activities
- **Secrets**: Securely store OAuth tokens and configuration
- **UI**: Add sidebar item and routing

## Security

- Tokens are stored securely in your OS keyring (via Wealthfolio's secrets API)
- Never stored in browser localStorage
- The proxy holds client credentials - tokens never reach your browser

## Troubleshooting

**Test Connection fails** - Check proxy URL and that the container is running

**Authentication fails** - Verify MONZO_CLIENT_ID/SECRET and REDIRECT_URI match your Monzo developer portal

**Transactions not syncing** - Check browser console for errors; verify token is valid
