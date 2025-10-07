# Salesforce Data Transfer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-blue.svg)](https://marketplace.visualstudio.com/VSCode)

A powerful Visual Studio Code extension for transferring data and maintaining relationships between Salesforce orgs. This extension helps developers and administrators easily migrate data while preserving object relationships and dependencies.

## 🚀 Open Source

This project is open source and welcomes contributions from the community! Feel free to:
- Report bugs and request features via [GitHub Issues](https://github.com/Shannu9119/salesforce-data-transfer-extension/issues)
- Submit pull requests to improve the extension
- Star the repository if you find it useful
- Share it with other Salesforce developers

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

## 🤝 Contributing

We welcome contributions from the community! Here's how you can help:

### Reporting Issues
- Use the [GitHub Issues](https://github.com/Shannu9119/salesforce-data-transfer-extension/issues) page
- Provide detailed information about bugs or feature requests
- Include steps to reproduce issues

### Development Setup
1. Clone the repository:
   ```bash
   git clone https://github.com/Shannu9119/salesforce-data-transfer-extension.git
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Open in VS Code and press `F5` to run the extension in Development Host

### Pull Requests
- Fork the repository
- Create a feature branch: `git checkout -b feature-name`
- Make your changes and test thoroughly
- Submit a pull request with a clear description

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with VS Code Extension API
- Integrates with Salesforce CLI
- Inspired by the need for better data migration tools in the Salesforce ecosystem

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
