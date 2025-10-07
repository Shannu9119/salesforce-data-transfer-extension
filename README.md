# Salesforce Data Transfer

A powerful Visual Studio Code extension for transferring data and maintaining relationships between Salesforce orgs. This extension helps developers and administrators easily migrate data while preserving object relationships and dependencies.

## Features

- **Multi-Org Support**: Seamlessly work with multiple authenticated Salesforce orgs
- **Relationship Awareness**: Automatically detect and handle object relationships during transfer
- **Batch Processing**: Configurable batch sizes for optimal performance
- **Interactive UI**: User-friendly webview panel for managing data transfers
- **Real-time Monitoring**: Live progress tracking and error reporting
- **Salesforce CLI Integration**: Leverages existing Salesforce CLI authentication

### Key Capabilities

- Transfer records between any authenticated Salesforce orgs
- Preserve lookup relationships and dependencies
- Handle standard and custom objects
- Batch processing for large datasets
- Comprehensive error handling and logging
- Tree view of available Salesforce orgs

## Requirements

- **Salesforce CLI**: Must be installed and configured
- **Authenticated Orgs**: Source and target orgs must be authenticated via Salesforce CLI
- **VS Code**: Version 1.104.0 or higher

### Installing Salesforce CLI

```bash
# Install Salesforce CLI
npm install -g @salesforce/cli

# Authenticate with your orgs
sf org login web --alias myorg
```

## Usage

### 1. Authenticate Salesforce Orgs

Before using the extension, ensure you have authenticated orgs via Salesforce CLI:

```bash
# Authenticate source org
sf org login web --alias source-org

# Authenticate target org  
sf org login web --alias target-org
```

### 2. Open Data Transfer Panel

- Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
- Search for "Salesforce Data Transfer: Open Data Transfer Panel"
- Or use the Activity Bar to access the Salesforce Data Transfer view

### 3. Configure Transfer

1. **Select Organizations**: Choose your source and target orgs from the dropdown
2. **Load Objects**: Click "Load Objects" to fetch available objects from the source org
3. **Select Objects**: Choose which objects to transfer
4. **Set Options**: Configure relationship handling and batch size
5. **Start Transfer**: Click "Start Transfer" to begin the data migration

### 4. Monitor Progress

- View real-time progress in the transfer log
- Monitor successful transfers and any errors
- Review summary statistics upon completion

## Commands

- `sf-data-transfer.openTransferPanel`: Open the main data transfer interface
- `sf-data-transfer.refreshOrgs`: Refresh the list of authenticated orgs
- `sf-data-transfer.selectSourceOrg`: Quick select source org from command palette
- `sf-data-transfer.selectTargetOrg`: Quick select target org from command palette

## Views

- **Salesforce Orgs**: Tree view showing all authenticated Salesforce orgs in the Explorer panel

## Known Issues

- Currently uses mock JSForce implementation - full Salesforce API integration coming soon
- Large datasets may require multiple batch operations
- Complex relationship hierarchies may need manual ordering

## Development

### Building the Extension

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes
npm run watch
```

### Running the Extension

1. Open the project in VS Code
2. Press `F5` to launch a new Extension Development Host
3. Test the extension features in the new window

## Release Notes

### 0.0.1

- Initial release with core data transfer functionality
- Multi-org support via Salesforce CLI integration
- Interactive webview panel for data transfer management
- Tree view for authenticated orgs
- Batch processing and progress monitoring

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
