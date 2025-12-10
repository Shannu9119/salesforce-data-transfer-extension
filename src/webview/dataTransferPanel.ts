import * as vscode from 'vscode';
import { SalesforceOrg, SalesforceOrgManager } from '../salesforce/orgManager';
import { DataTransferService, DataTransferOptions } from '../salesforce/dataTransferService';

export class DataTransferPanel {
    public static currentPanel: DataTransferPanel | undefined;
    public static readonly viewType = 'sfDataTransfer';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        private orgManager: SalesforceOrgManager,
        private dataTransferService: DataTransferService
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'getOrgs':
                        await this._sendOrgs();
                        break;
                    case 'getObjectTypes':
                        await this._sendObjectTypes(message.sourceOrgUsername);
                        break;
                    case 'validateQuery':
                        await this._validateQuery(message.query, message.sourceOrgUsername);
                        break;
                    case 'previewQuery':
                        await this._previewQuery(message.query, message.sourceOrgUsername);
                        break;
                    case 'startTransfer':
                        await this._startTransfer(message.options);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        orgManager: SalesforceOrgManager,
        dataTransferService: DataTransferService
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (DataTransferPanel.currentPanel) {
            DataTransferPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            DataTransferPanel.viewType,
            'Salesforce Data Transfer',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'out'),
                    vscode.Uri.joinPath(extensionUri, 'webview')
                ]
            }
        );

        DataTransferPanel.currentPanel = new DataTransferPanel(
            panel,
            extensionUri,
            orgManager,
            dataTransferService
        );
    }

    private async _sendOrgs() {
        try {
            // Show loading notification
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Loading Salesforce orgs...",
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 0 });
                
                // Refresh orgs first to ensure we have the latest data
                const orgs = await this.orgManager.refreshOrgs();
                console.log('Sending orgs to webview:', orgs);
                
                progress.report({ increment: 100 });
                
                this._panel.webview.postMessage({
                    type: 'orgs',
                    data: orgs
                });
                
                if (orgs.length > 0) {
                    vscode.window.showInformationMessage(`Loaded ${orgs.length} authenticated Salesforce orgs`);
                } else {
                    vscode.window.showWarningMessage('No authenticated Salesforce orgs found. Please authenticate using Salesforce CLI.');
                }
            });
        } catch (error) {
            console.error('Error sending orgs to webview:', error);
            vscode.window.showErrorMessage(`Failed to load orgs: ${error}`);
            this._panel.webview.postMessage({
                type: 'error',
                data: `Failed to load orgs: ${error}`
            });
        }
    }

    private async _sendObjectTypes(sourceOrgUsername: string) {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Loading Salesforce objects...",
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ increment: 10, message: "Finding source org..." });
                
                const orgs = this.orgManager.getOrgs();
                const sourceOrg = orgs.find(org => org.username === sourceOrgUsername);
                
                if (!sourceOrg) {
                    throw new Error('Source org not found');
                }

                progress.report({ increment: 30, message: "Getting access token..." });

                // Get access token and validate it
                const accessToken = await this.orgManager.getAccessToken(sourceOrg.username);
                if (!accessToken) {
                    throw new Error(`Could not retrieve access token for ${sourceOrg.alias || sourceOrg.username}. Please re-authenticate the org using: sf org login web --alias ${sourceOrg.alias || sourceOrg.username}`);
                }

                progress.report({ increment: 40, message: "Validating access token..." });

                // Validate the token before using it
                const isTokenValid = await this.orgManager.validateAccessToken(sourceOrg.instanceUrl, accessToken);
                if (!isTokenValid) {
                    throw new Error(`Access token for ${sourceOrg.alias || sourceOrg.username} is invalid or expired. Please re-authenticate using: sf org login web --alias ${sourceOrg.alias || sourceOrg.username}`);
                }

                sourceOrg.accessToken = accessToken;
                
                progress.report({ increment: 50, message: "Connecting to Salesforce..." });
                
                // Initialize data transfer service with source org
                const tempTargetOrg = { ...sourceOrg }; // Use same org as temp target for initialization
                await this.dataTransferService.initializeConnections(sourceOrg, tempTargetOrg);
                
                progress.report({ increment: 70, message: "Fetching all available objects..." });
                
                // Get all objects from the org (standard, custom, and managed packages)
                const allObjects = await this.dataTransferService.getObjectTypes();

                this._panel.webview.postMessage({
                    type: 'objectTypes',
                    data: allObjects
                });
                
                progress.report({ increment: 100 });
                
                // Count different types of objects
                const standardObjects = allObjects.filter(obj => !obj.includes('__')).length;
                const customObjects = allObjects.filter(obj => obj.endsWith('__c')).length;
                const managedObjects = allObjects.filter(obj => obj.includes('__') && !obj.endsWith('__c')).length;
                
                vscode.window.showInformationMessage(
                    `Loaded ${allObjects.length} objects from ${sourceOrg.alias || sourceOrg.username}: ` +
                    `${standardObjects} standard, ${customObjects} custom, ${managedObjects} managed package`
                );
                
            } catch (error) {
                console.error('Error in _sendObjectTypes:', error);
                vscode.window.showErrorMessage(`Failed to load objects: ${error}`);
                this._panel.webview.postMessage({
                    type: 'error',
                    data: `Failed to get object types: ${error}`
                });
            }
        });
    }

    private async _startTransfer(options: any) {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Transferring Salesforce data...",
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ increment: 0, message: "Initializing transfer..." });
                
                this._panel.webview.postMessage({
                    type: 'transferStarted',
                    data: 'Data transfer started...'
                });

                // Get orgs and access tokens
                progress.report({ increment: 10, message: "Validating organizations..." });
                
                const orgs = this.orgManager.getOrgs();
                const sourceOrg = orgs.find(org => org.username === options.sourceOrg);
                const targetOrg = orgs.find(org => org.username === options.targetOrg);

                if (!sourceOrg || !targetOrg) {
                    throw new Error('Source or target org not found');
                }

                // Get access tokens
                progress.report({ increment: 25, message: "Getting access tokens..." });
                
                const sourceToken = await this.orgManager.getAccessToken(sourceOrg.username);
                const targetToken = await this.orgManager.getAccessToken(targetOrg.username);

                if (!sourceToken || !targetToken) {
                    throw new Error('Failed to get access tokens for one or both orgs');
                }

                sourceOrg.accessToken = sourceToken;
                targetOrg.accessToken = targetToken;

                progress.report({ increment: 40, message: "Preparing data transfer..." });

                const transferOptions: DataTransferOptions = {
                    sourceOrg,
                    targetOrg,
                    includeRelationships: options.includeRelationships || false,
                    batchSize: options.batchSize || 200,
                    transferMode: options.transferMode || 'insert'
                };

                // Support custom query mode
                if (options.customQuery && typeof options.customQuery === 'string' && options.customQuery.trim()) {
                    transferOptions.customQuery = options.customQuery.trim();
                }

                // Support object list mode
                if (Array.isArray(options.objectTypes)) {
                    transferOptions.objectTypes = options.objectTypes;
                }

                // Pass record limits if provided
                if (options.recordLimits && typeof options.recordLimits === 'object') {
                    transferOptions.recordLimits = options.recordLimits;
                }

                // Pass external ID mapping if provided
                if (options.externalIdMapping && typeof options.externalIdMapping === 'object') {
                    transferOptions.externalIdMapping = options.externalIdMapping;
                }

                // Initialize connections and start transfer
                progress.report({ increment: 60, message: "Connecting to Salesforce orgs..." });
                
                await this.dataTransferService.initializeConnections(sourceOrg, targetOrg);
                
                progress.report({ increment: 80, message: "Transferring data..." });
                
                const result = await this.dataTransferService.transferData(transferOptions);

                progress.report({ increment: 100, message: "Transfer complete!" });

                this._panel.webview.postMessage({
                    type: 'transferComplete',
                    data: result
                });

                if (result.success) {
                    vscode.window.showInformationMessage(
                        `Data transfer completed! ${result.recordsTransferred} records transferred.`
                    );
                } else {
                    vscode.window.showWarningMessage(
                        `Data transfer completed with errors. ${result.recordsTransferred} records transferred, ${result.errors.length} errors.`
                    );
                }

            } catch (error) {
                console.error('Transfer error:', error);
                vscode.window.showErrorMessage(`Data transfer failed: ${error}`);
                this._panel.webview.postMessage({
                    type: 'transferError',
                    data: `Transfer failed: ${error}`
                });
            }
        });
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Salesforce Data Transfer</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            line-height: 1.5;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
        }
        h1 {
            color: var(--vscode-foreground);
            border-bottom: 2px solid var(--vscode-focusBorder);
            padding-bottom: 10px;
            margin-bottom: 30px;
            font-size: 24px;
        }
        .section {
            margin-bottom: 25px;
            padding: 24px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            background-color: var(--vscode-sideBar-background);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        .section h2 {
            margin-top: 0;
            margin-bottom: 20px;
            color: var(--vscode-foreground);
            font-size: 18px;
            display: flex;
            align-items: center;
        }
        .section h2::before {
            content: '';
            display: inline-block;
            width: 4px;
            height: 20px;
            background-color: var(--vscode-focusBorder);
            margin-right: 12px;
            border-radius: 2px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group > label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            font-size: 14px;
            color: var(--vscode-foreground);
        }
        .checkbox-group {
            display: flex;
            align-items: center;
            margin-bottom: 15px;
            padding: 12px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
        }
        .checkbox-group input[type="checkbox"] {
            margin-right: 10px;
            width: 16px;
            height: 16px;
        }
        .checkbox-group label {
            margin: 0;
            cursor: pointer;
            font-weight: normal;
        }
        .search-container {
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .search-container input[type="text"] {
            flex-grow: 1;
            padding: 12px 16px;
            border: 2px solid var(--vscode-input-border);
            border-radius: 25px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-size: 14px;
            transition: all 0.3s ease;
        }
        .search-container input[type="text"]:focus {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 3px rgba(0, 122, 204, 0.1);
        }
        .search-stats {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
        }
        .transfer-mode-selector {
            margin-bottom: 20px;
            display: flex;
            gap: 20px;
            padding: 16px;
            background-color: var(--vscode-input-background);
            border-radius: 8px;
            border: 1px solid var(--vscode-input-border);
        }
        .transfer-mode-selector label {
            display: flex;
            align-items: center;
            cursor: pointer;
            font-weight: 500;
        }
        .transfer-mode-selector input[type="radio"] {
            margin-right: 8px;
            width: 16px;
            height: 16px;
        }
        .record-limit-input {
            display: none;
            margin-left: 20px;
            padding: 8px 12px;
            width: 100px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        textarea {
            width: 100%;
            padding: 16px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 8px;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            resize: vertical;
            min-height: 120px;
        }
        textarea:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.2);
        }
        .query-actions {
            margin-top: 15px;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .validation-result {
            padding: 10px 16px;
            border-radius: 6px;
            font-size: 13px;
            margin-left: 20px;
            display: inline-block;
            font-weight: 500;
            transition: all 0.3s ease;
            min-width: 200px;
        }
        .validation-result:empty {
            display: none;
        }
        .validation-success {
            background-color: rgba(76, 175, 80, 0.15);
            border: 1px solid rgba(76, 175, 80, 0.4);
            color: #4CAF50;
            animation: slideIn 0.3s ease;
        }
        .validation-error {
            background-color: rgba(244, 67, 54, 0.15);
            border: 1px solid rgba(244, 67, 54, 0.4);
            color: #f44336;
            animation: slideIn 0.3s ease;
            max-width: 600px;
            word-wrap: break-word;
        }
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(-10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        .query-preview {
            margin-top: 20px;
            padding: 16px;
            background-color: var(--vscode-textCodeBlock-background);
            border-radius: 8px;
            border: 1px solid var(--vscode-panel-border);
        }
        .query-preview h4 {
            margin-top: 0;
            color: var(--vscode-foreground);
        }
        .preview-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
        }
        .preview-table th,
        .preview-table td {
            padding: 8px 12px;
            text-align: left;
            border: 1px solid var(--vscode-panel-border);
            font-size: 12px;
        }
        .preview-table th {
            background-color: var(--vscode-editor-background);
            font-weight: bold;
        }
        .object-item-extended {
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .object-selection {
            flex: 1;
            display: flex;
            align-items: center;
        }
        .record-options {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 12px;
        }
        .record-limit {
            width: 80px;
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        select, input {
            width: 100%;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 2px;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 20px;
            border-radius: 2px;
            cursor: pointer;
            margin-right: 10px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .object-list {
            max-height: 400px;
            overflow-y: auto;
            border: 1px solid var(--vscode-input-border);
            padding: 10px;
        }
        .object-section {
            margin-bottom: 15px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .section-header {
            background: linear-gradient(135deg, var(--vscode-editor-background), var(--vscode-sideBar-background));
            padding: 16px 20px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 12px;
            border-radius: 8px 8px 0 0;
        }
        .section-header h4 {
            margin: 0;
            flex-grow: 1;
            color: var(--vscode-foreground);
            font-size: 16px;
            font-weight: 600;
        }
        .section-header h2 {
            margin: 0;
            flex-grow: 1;
            color: var(--vscode-foreground);
            font-size: 18px;
            font-weight: 600;
        }
        .back-button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 6px 12px;
            font-size: 12px;
            cursor: pointer;
            border-radius: 4px;
        }
        .back-button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .toggle-btn, .select-all-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 6px 12px;
            font-size: 12px;
            cursor: pointer;
            border-radius: 4px;
            transition: all 0.2s ease;
            font-weight: 500;
        }
        .toggle-btn:hover, .select-all-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
            transform: translateY(-1px);
        }
        .toggle-btn {
            min-width: 30px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .section-content {
            padding: 20px;
            max-height: 200px;
            overflow-y: auto;
        }
        .section-content::-webkit-scrollbar {
            width: 8px;
        }
        .section-content::-webkit-scrollbar-track {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 4px;
        }
        .section-content::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-activeBackground);
            border-radius: 4px;
        }
        .section-content::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
        }
        .object-item {
            margin-bottom: 8px;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background-color: var(--vscode-input-background);
            transition: all 0.2s ease;
            cursor: pointer;
        }
        .object-item:hover {
            background-color: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }
        .object-item label {
            display: flex;
            align-items: center;
            cursor: pointer;
            margin: 0;
            width: 100%;
        }
        .object-item input[type="checkbox"] {
            margin-right: 12px;
            width: 16px;
            height: 16px;
            cursor: pointer;
            flex-shrink: 0;
        }
        .object-name {
            flex-grow: 1;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            color: var(--vscode-foreground);
            user-select: none;
        }
        .object-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
            border-color: var(--vscode-focusBorder);
        }
        .standard-objects {
            background-color: var(--vscode-editor-background);
            border-left: 4px solid #007ACC;
        }
        .custom-objects {
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 4px solid #FF6B6B;
        }
        .managed-objects {
            background-color: var(--vscode-textPreformat-background);
            border-left: 4px solid #4ECDC4;
        }
        select, input[type="number"] {
            width: 100%;
            padding: 12px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 6px;
            font-size: 14px;
            transition: border-color 0.2s ease;
        }
        select:focus, input[type="number"]:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.2);
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 12px 24px;
            border-radius: 6px;
            cursor: pointer;
            margin-right: 12px;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s ease;
        }
        button:hover:not(:disabled) {
            background-color: var(--vscode-button-hoverBackground);
            transform: translateY(-1px);
        }
        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }
        .log {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 20px;
            border-radius: 8px;
            font-family: var(--vscode-editor-font-family);
            white-space: pre-wrap;
            max-height: 250px;
            overflow-y: auto;
            border: 1px solid var(--vscode-panel-border);
            font-size: 13px;
            line-height: 1.4;
        }
        .log::-webkit-scrollbar {
            width: 8px;
        }
        .log::-webkit-scrollbar-track {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 4px;
        }
        .log::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-activeBackground);
            border-radius: 4px;
        }
        .error {
            color: var(--vscode-errorForeground);
        }
        .success {
            color: var(--vscode-testing-iconPassed);
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Salesforce Data Transfer</h1>
        
        <div class="section">
            <h2>1. Select Organizations</h2>
            <div class="form-group">
                <label for="sourceOrg">Source Org:</label>
                <select id="sourceOrg">
                    <option value="">Select source org...</option>
                </select>
            </div>
            <div class="form-group">
                <label for="targetOrg">Target Org:</label>
                <select id="targetOrg">
                    <option value="">Select target org...</option>
                </select>
            </div>
            <button onclick="loadObjectTypes()">📋 Load Objects</button>
        </div>

        <div class="section">
            <h2>2. Select Objects and Records to Transfer</h2>
            <div class="search-container">
                <input type="text" id="objectSearch" placeholder="🔍 Search objects..." onkeyup="filterObjects()" />
                <div class="search-stats" id="searchStats"></div>
            </div>
            <div class="transfer-mode-selector">
                <label>
                    <input type="radio" name="transferMode" value="all" checked onchange="toggleTransferMode()"> Transfer All Records
                </label>
                <label>
                    <input type="radio" name="transferMode" value="limited" onchange="toggleTransferMode()"> Transfer Limited Records
                </label>
                <label>
                    <input type="radio" name="transferMode" value="custom" onchange="toggleTransferMode()"> Custom SOQL Query
                </label>
            </div>
            <div id="objectTypes" class="object-list">
                <p>Select organizations first...</p>
            </div>
        </div>

        <div class="section" id="soqlQuerySection" style="display: none;">
            <div class="section-header">
                <h2>3. Custom SOQL Query</h2>
                <button onclick="goBackToTransferMode()" class="back-button">⬅️ Back to Options</button>
            </div>
            <div class="form-group">
                <label for="soqlQuery">SOQL Query:</label>
                <textarea id="soqlQuery" rows="6" placeholder="SELECT Id, Name FROM Account WHERE CreatedDate = TODAY LIMIT 100" onkeyup="updateTransferButton()"></textarea>
            </div>
            <div class="query-actions">
                <button onclick="validateQuery()" id="validateBtn">✅ Validate Query</button>
                <button onclick="previewQuery()" id="previewBtn">👁️ Preview Results</button>
                <div id="queryValidation" class="validation-result"></div>
            </div>
            <div id="queryPreview" class="query-preview" style="display: none;">
                <h4>Query Preview:</h4>
                <div id="previewData"></div>
            </div>
        </div>

        <div class="section">
            <h2 id="transferOptionsTitle">4. Transfer Options</h2>
            
            <div class="form-group">
                <label>Transfer Mode:</label>
                <div class="transfer-mode-selector" style="margin-top: 8px;">
                    <label>
                        <input type="radio" name="dataTransferMode" value="insert" checked onchange="toggleRelationshipOptions()"> 
                        Insert Mode (Create new records)
                    </label>
                    <label>
                        <input type="radio" name="dataTransferMode" value="upsert" onchange="toggleRelationshipOptions()"> 
                        Upsert Mode (Update existing records)
                    </label>
                </div>
                <p style="font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 8px;">
                    Insert mode creates new records and handles parent-child relationships automatically. 
                    Upsert mode requires external ID fields for matching existing records.
                </p>
            </div>

            <div class="checkbox-group">
                <input type="checkbox" id="includeRelationships" onchange="toggleRelationshipOptions()">
                <label for="includeRelationships">Include Relationships</label>
            </div>

            <div id="externalIdConfig" class="form-group" style="display: none;">
                <label>External ID Configuration (Required for Upsert Mode):</label>
                <div id="externalIdMappings" style="margin-top: 10px;">
                    <p style="font-size: 12px; color: var(--vscode-descriptionForeground);">
                        When objects are loaded, you can specify external ID fields for each object type.
                    </p>
                </div>
            </div>
            <div class="form-group">
                <label for="batchSize">Batch Size:</label>
                <input type="number" id="batchSize" value="200" min="1" max="2000" placeholder="Enter batch size (1-2000)">
            </div>
            <button onclick="startTransfer()" id="transferBtn" disabled>🚀 Start Transfer</button>
        </div>

        <div class="section">
            <h2>Transfer Log</h2>
            <div id="log" class="log">Ready to transfer data...</div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let orgs = [];
        let objectTypes = [];

        window.addEventListener('message', event => {
            const message = event.data;
            console.log('Webview received message:', message);
            
            switch (message.type) {
                case 'orgs':
                    orgs = message.data;
                    console.log('Received orgs data:', orgs);
                    populateOrgSelects();
                    break;
                case 'objectTypes':
                    objectTypes = message.data;
                    populateObjectTypes();
                    // Update search stats
                    setTimeout(filterObjects, 100);
                    break;
                case 'queryValidation':
                    const validationDiv = document.getElementById('queryValidation');
                    if (message.isValid) {
                        validationDiv.style.display = 'inline-block';
                        validationDiv.className = 'validation-result validation-success';
                        validationDiv.textContent = '✓ Query is valid';
                        validationDiv.style.backgroundColor = '';
                        validationDiv.style.borderColor = '';
                        validationDiv.style.color = '';
                        autoDismissValidation(5000); // Dismiss after 5 seconds
                    } else {
                        validationDiv.style.display = 'inline-block';
                        validationDiv.className = 'validation-result validation-error';
                        validationDiv.textContent = '✗ ' + (message.error || 'Invalid query');
                        validationDiv.style.backgroundColor = '';
                        validationDiv.style.borderColor = '';
                        validationDiv.style.color = '';
                        autoDismissValidation(10000); // Dismiss after 10 seconds for errors
                    }
                    break;
                case 'queryPreview':
                    displayQueryPreview(message.data);
                    break;
                case 'transferStarted':
                    addToLog(message.data);
                    document.getElementById('transferBtn').disabled = true;
                    break;
                case 'transferComplete':
                    addToLog(\`Transfer completed! Records transferred: \${message.data.recordsTransferred}\`, 'success');
                    if (message.data.errors.length > 0) {
                        addToLog(\`Errors: \${message.data.errors.join(', ')}\`, 'error');
                    }
                    document.getElementById('transferBtn').disabled = false;
                    break;
                case 'transferError':
                    addToLog(message.data, 'error');
                    document.getElementById('transferBtn').disabled = false;
                    break;
                case 'error':
                    addToLog(message.data, 'error');
                    break;
            }
        });

        function displayQueryPreview(data) {
            const previewDiv = document.getElementById('queryPreview');
            const previewData = document.getElementById('previewData');
            
            if (data && data.records && data.records.length > 0) {
                const records = data.records; // Show all records returned by the query
                const fields = Object.keys(records[0]).filter(key => key !== 'attributes');
                
                let tableHtml = '<table class="preview-table"><thead><tr>';
                fields.forEach(field => {
                    tableHtml += \`<th>\${field}</th>\`;
                });
                tableHtml += '</tr></thead><tbody>';
                
                records.forEach(record => {
                    tableHtml += '<tr>';
                    fields.forEach(field => {
                        const value = record[field] || '';
                        tableHtml += \`<td>\${typeof value === 'object' ? JSON.stringify(value) : value}</td>\`;
                    });
                    tableHtml += '</tr>';
                });
                
                tableHtml += '</tbody></table>';
                const actualRecordCount = data.records.length;
                const totalAvailable = data.totalSize || actualRecordCount;
                const done = data.done ? 'All records retrieved' : 'More records available';
                tableHtml += \`<p><strong>Results:</strong> Retrieved \${actualRecordCount} records. Total available in org: \${totalAvailable}. \${done}</p>\`;
                
                previewData.innerHTML = tableHtml;
                previewDiv.style.display = 'block';
                
                addToLog(\`Query executed successfully: Retrieved \${actualRecordCount} records (Total available: \${totalAvailable})\`, 'success');
            } else {
                previewData.innerHTML = '<p>No records found for this query.</p>';
                previewDiv.style.display = 'block';
                addToLog('Query returned no records', 'info');
            }
        }

        function populateOrgSelects() {
            console.log('populateOrgSelects called with orgs:', orgs);
            const sourceSelect = document.getElementById('sourceOrg');
            const targetSelect = document.getElementById('targetOrg');
            
            if (!sourceSelect || !targetSelect) {
                console.error('Could not find org select elements');
                return;
            }
            
            sourceSelect.innerHTML = '<option value="">Select source org...</option>';
            targetSelect.innerHTML = '<option value="">Select target org...</option>';
            
            if (!orgs || orgs.length === 0) {
                console.log('No orgs available');
                addToLog('No authenticated orgs found. Please authenticate orgs using Salesforce CLI.', 'error');
                return;
            }
            
            orgs.forEach(org => {
                console.log('Adding org to dropdown:', org);
                const option = document.createElement('option');
                option.value = org.username;
                option.textContent = org.alias || org.username;
                
                sourceSelect.appendChild(option.cloneNode(true));
                targetSelect.appendChild(option);
            });
            
            addToLog(\`Loaded \${orgs.length} authenticated orgs\`);
        }

        function populateObjectTypes() {
            const container = document.getElementById('objectTypes');
            container.innerHTML = '';
            
            if (!objectTypes || objectTypes.length === 0) {
                container.innerHTML = '<p>No objects available. Please select a source org and click "Load Objects".</p>';
                return;
            }
            
            // Group objects by type
            const standardObjects = objectTypes.filter(obj => !obj.includes('__'));
            const customObjects = objectTypes.filter(obj => obj.endsWith('__c'));
            const managedObjects = objectTypes.filter(obj => obj.includes('__') && !obj.endsWith('__c'));
            
            // Create grouped sections
            if (standardObjects.length > 0) {
                const section = createObjectSection('Standard Objects', standardObjects, 'standard');
                container.appendChild(section);
            }
            
            if (customObjects.length > 0) {
                const section = createObjectSection('Custom Objects', customObjects, 'custom');
                container.appendChild(section);
            }
            
            if (managedObjects.length > 0) {
                // Group managed objects by namespace
                const managedByNamespace = {};
                managedObjects.forEach(obj => {
                    const namespace = obj.split('__')[0];
                    if (!managedByNamespace[namespace]) {
                        managedByNamespace[namespace] = [];
                    }
                    managedByNamespace[namespace].push(obj);
                });
                
                Object.keys(managedByNamespace).sort().forEach(namespace => {
                    const section = createObjectSection(\`Managed Package: \${namespace}\`, managedByNamespace[namespace], 'managed');
                    container.appendChild(section);
                });
            }
        }

        function createObjectSection(title, objects, type) {
            const section = document.createElement('div');
            section.className = 'object-section';
            section.innerHTML = \`
                <div class="section-header">
                    <h4>\${title} (\${objects.length})</h4>
                    <button type="button" onclick="toggleSection(this)" class="toggle-btn">▼</button>
                    <button type="button" onclick="selectAllInSection(this, true)" class="select-all-btn">Select All</button>
                    <button type="button" onclick="selectAllInSection(this, false)" class="select-all-btn">Deselect All</button>
                </div>
                <div class="section-content \${type}-objects">
                    \${objects.map(obj => \`
                        <div class="object-item object-item-extended" data-object="\${obj}">
                            <div class="object-selection">
                                <input type="checkbox" value="\${obj}" onchange="updateTransferButton(); updateObjectItemStyle(this)" onclick="event.stopPropagation()"> 
                                <span class="object-name" onclick="toggleObjectByName('\${obj}')">\${obj}</span>
                            </div>
                            <div class="record-options" id="options-\${obj.replace(/[^a-zA-Z0-9]/g, '_')}">
                                <span>Records:</span>
                                <select class="record-limit" onchange="updateRecordLimit('\${obj}', this.value)" onclick="event.stopPropagation()">
                                    <option value="all">All</option>
                                    <option value="100">100</option>
                                    <option value="500">500</option>
                                    <option value="1000">1K</option>
                                    <option value="5000">5K</option>
                                    <option value="custom">Custom</option>
                                </select>
                                <input type="number" class="record-limit custom-limit" placeholder="Count" min="1" style="display: none; width: 70px;" onchange="updateCustomLimit('\${obj}', this.value)" onclick="event.stopPropagation()">
                            </div>
                        </div>
                    \`).join('')}
                </div>
            \`;
            return section;
        }

        function toggleSection(button) {
            const content = button.parentElement.nextElementSibling;
            const isVisible = content.style.display !== 'none';
            content.style.display = isVisible ? 'none' : 'block';
            button.textContent = isVisible ? '▶' : '▼';
        }

        function selectAllInSection(button, select) {
            const section = button.parentElement.parentElement;
            const checkboxes = section.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => {
                cb.checked = select;
                updateObjectItemStyle(cb);
            });
            updateTransferButton();
        }

        function toggleObjectSelection(objectItem) {
            const checkbox = objectItem.querySelector('input[type="checkbox"]');
            if (checkbox && !checkbox.disabled) {
                checkbox.checked = !checkbox.checked;
                updateObjectItemStyle(checkbox);
                updateTransferButton();
            }
        }

        function updateObjectItemStyle(checkbox) {
            const objectItem = checkbox.closest('.object-item');
            if (objectItem) {
                if (checkbox.checked) {
                    objectItem.classList.add('selected');
                } else {
                    objectItem.classList.remove('selected');
                }
            }
            // Update external ID mappings when objects are selected/deselected
            toggleRelationshipOptions();
        }

        function toggleObjectByName(objectName) {
            const objectItem = document.querySelector(\`[data-object="\${objectName}"]\`);
            if (objectItem) {
                const checkbox = objectItem.querySelector('input[type="checkbox"]');
                if (checkbox) {
                    checkbox.checked = !checkbox.checked;
                    updateObjectItemStyle(checkbox);
                    updateTransferButton();
                }
            }
        }

        function filterObjects() {
            const searchTerm = document.getElementById('objectSearch').value.toLowerCase();
            const objectItems = document.querySelectorAll('.object-item');
            let visibleCount = 0;
            let totalCount = objectItems.length;

            objectItems.forEach(item => {
                const objectName = item.dataset.object;
                const isVisible = objectName && objectName.toLowerCase().includes(searchTerm);
                item.style.display = isVisible ? 'flex' : 'none';
                if (isVisible) visibleCount++;
            });

            // Update search stats
            const searchStats = document.getElementById('searchStats');
            if (searchStats) {
                if (searchTerm) {
                    searchStats.textContent = \`Showing \${visibleCount} of \${totalCount} objects\`;
                } else {
                    searchStats.textContent = \`\${totalCount} objects total\`;
                }
            }
        }

        function toggleTransferMode() {
            const mode = document.querySelector('input[name="transferMode"]:checked').value;
            const soqlSection = document.getElementById('soqlQuerySection');
            const objectTypesSection = document.querySelector('#objectTypes').parentElement;
            const transferTitle = document.getElementById('transferOptionsTitle');

            if (mode === 'custom') {
                soqlSection.style.display = 'block';
                objectTypesSection.style.display = 'none';
                transferTitle.textContent = '5. Transfer Options';
            } else {
                soqlSection.style.display = 'none';
                objectTypesSection.style.display = 'block';
                transferTitle.textContent = '4. Transfer Options';
            }

            updateTransferButton();
        }

        function goBackToTransferMode() {
            // Switch radio back to a non-custom mode (default to 'all')
            const allRadio = document.querySelector('input[name="transferMode"][value="all"]');
            if (allRadio) {
                allRadio.checked = true;
            }
            // Trigger the UI toggle
            toggleTransferMode();
            // Ensure query section is hidden
            const soqlSection = document.getElementById('soqlQuerySection');
            if (soqlSection) soqlSection.style.display = 'none';
            // Show object selection back
            const objectTypesSection = document.querySelector('#objectTypes').parentElement;
            if (objectTypesSection) objectTypesSection.style.display = 'block';
            // Reset title numbering
            const transferTitle = document.getElementById('transferOptionsTitle');
            if (transferTitle) transferTitle.textContent = '4. Transfer Options';
            // Update button state
            updateTransferButton();
        }

        function updateRecordLimit(objectName, value) {
            const optionsDiv = document.getElementById(\`options-\${objectName.replace(/[^a-zA-Z0-9]/g, '_')}\`);
            const customInput = optionsDiv.querySelector('.custom-limit');
            
            if (value === 'custom') {
                customInput.style.display = 'inline-block';
                customInput.focus();
            } else {
                customInput.style.display = 'none';
                customInput.value = '';
            }
        }

        function updateCustomLimit(objectName, value) {
            // Store custom limit for this object
            if (!window.recordLimits) {
                window.recordLimits = {};
            }
            window.recordLimits[objectName] = parseInt(value) || 0;
        }

        let validationTimeout = null;
        
        function autoDismissValidation(delay = 5000) {
            // Clear any existing timeout
            if (validationTimeout) {
                clearTimeout(validationTimeout);
            }
            
            // Set new timeout to clear the validation message
            validationTimeout = setTimeout(() => {
                const validationDiv = document.getElementById('queryValidation');
                if (validationDiv) {
                    validationDiv.className = 'validation-result';
                    validationDiv.textContent = '';
                    validationDiv.style.display = 'none';
                }
            }, delay);
        }
        
        function validateQuery() {
            const query = document.getElementById('soqlQuery').value.trim();
            const validationDiv = document.getElementById('queryValidation');
            const sourceOrg = document.getElementById('sourceOrg').value;
            
            if (!query) {
                validationDiv.style.display = 'inline-block';
                validationDiv.className = 'validation-result validation-error';
                validationDiv.textContent = 'Please enter a SOQL query';
                autoDismissValidation();
                return;
            }

            if (!sourceOrg) {
                validationDiv.style.display = 'inline-block';
                validationDiv.className = 'validation-result validation-error';
                validationDiv.textContent = 'Please select a source org first';
                autoDismissValidation();
                return;
            }

            // Show validating message
            validationDiv.style.display = 'inline-block';
            validationDiv.className = 'validation-result';
            validationDiv.style.backgroundColor = 'rgba(100, 150, 200, 0.1)';
            validationDiv.style.borderColor = 'rgba(100, 150, 200, 0.3)';
            validationDiv.style.color = 'var(--vscode-foreground)';
            validationDiv.textContent = '⏳ Validating query against Salesforce...';

            // Send validation request to extension
            vscode.postMessage({
                type: 'validateQuery',
                query: query,
                sourceOrgUsername: sourceOrg
            });
        }

        function previewQuery() {
            const query = document.getElementById('soqlQuery').value.trim();
            if (!query) {
                addToLog('Please enter a SOQL query first', 'error');
                return;
            }

            const sourceOrg = document.getElementById('sourceOrg').value;
            if (!sourceOrg) {
                addToLog('Please select a source org first', 'error');
                return;
            }

            // Send preview request to extension
            vscode.postMessage({
                type: 'previewQuery',
                query: query,
                sourceOrgUsername: sourceOrg
            });
        }

        function loadObjectTypes() {
            const sourceOrg = document.getElementById('sourceOrg').value;
            if (!sourceOrg) {
                addToLog('Please select a source org first', 'error');
                return;
            }
            
            addToLog('Loading object types...');
            vscode.postMessage({
                type: 'getObjectTypes',
                sourceOrgUsername: sourceOrg
            });
        }

        function toggleRelationshipOptions() {
            const includeRelationships = document.getElementById('includeRelationships').checked;
            const transferMode = document.querySelector('input[name="dataTransferMode"]:checked').value;
            const externalIdConfig = document.getElementById('externalIdConfig');
            
            if (includeRelationships && transferMode === 'upsert') {
                externalIdConfig.style.display = 'block';
                updateExternalIdMappings();
            } else {
                externalIdConfig.style.display = 'none';
            }
        }

        function updateExternalIdMappings() {
            const mappingsDiv = document.getElementById('externalIdMappings');
            const selectedObjects = Array.from(document.querySelectorAll('#objectTypes input[type="checkbox"]:checked'))
                .map(cb => cb.value);
            
            // Clear previous content
            mappingsDiv.innerHTML = '';
            
            if (selectedObjects.length === 0) {
                const p = document.createElement('p');
                p.style.fontSize = '12px';
                p.style.color = 'var(--vscode-descriptionForeground)';
                p.textContent = 'Select objects first to configure external ID fields.';
                mappingsDiv.appendChild(p);
                return;
            }
            
            // Create grid container
            const gridDiv = document.createElement('div');
            gridDiv.style.display = 'grid';
            gridDiv.style.gridTemplateColumns = '1fr 1fr';
            gridDiv.style.gap = '10px';
            gridDiv.style.marginTop = '10px';
            
            selectedObjects.forEach(obj => {
                const itemDiv = document.createElement('div');
                
                const label = document.createElement('label');
                label.style.fontSize = '12px';
                label.style.fontWeight = '500';
                label.textContent = obj + ':';
                
                const input = document.createElement('input');
                input.type = 'text';
                input.id = 'extId_' + obj.replace(/[^a-zA-Z0-9]/g, '_');
                input.placeholder = 'External ID field name';
                input.style.width = '100%';
                input.style.padding = '4px 8px';
                input.style.fontSize = '12px';
                input.style.marginTop = '4px';
                input.title = 'Enter the API name of the external ID field for ' + obj;
                
                itemDiv.appendChild(label);
                itemDiv.appendChild(input);
                gridDiv.appendChild(itemDiv);
            });
            
            mappingsDiv.appendChild(gridDiv);
            
            // Add example text
            const exampleP = document.createElement('p');
            exampleP.style.fontSize = '11px';
            exampleP.style.color = 'var(--vscode-descriptionForeground)';
            exampleP.style.marginTop = '8px';
            exampleP.textContent = 'Example: External_Id__c, Legacy_System_Id__c';
            mappingsDiv.appendChild(exampleP);
        }

        function updateTransferButton() {
            const sourceOrg = document.getElementById('sourceOrg').value;
            const targetOrg = document.getElementById('targetOrg').value;
            const mode = document.querySelector('input[name="transferMode"]:checked').value;
            
            let canTransfer = false;
            
            if (sourceOrg && targetOrg) {
                if (mode === 'custom') {
                    const query = document.getElementById('soqlQuery').value.trim();
                    canTransfer = query.length > 0;
                } else {
                    const selectedObjects = Array.from(document.querySelectorAll('#objectTypes input[type="checkbox"]:checked'));
                    canTransfer = selectedObjects.length > 0;
                }
            }
            
            document.getElementById('transferBtn').disabled = !canTransfer;
        }

        function startTransfer() {
            const sourceOrg = document.getElementById('sourceOrg').value;
            const targetOrg = document.getElementById('targetOrg').value;
            const mode = document.querySelector('input[name="transferMode"]:checked').value;
            const includeRelationships = document.getElementById('includeRelationships').checked;
            const batchSize = parseInt(document.getElementById('batchSize').value);
            const transferMode = document.querySelector('input[name="dataTransferMode"]:checked').value;
            
            if (!sourceOrg || !targetOrg) {
                addToLog('Please select source and target orgs', 'error');
                return;
            }
            
            let transferOptions = {
                sourceOrg,
                targetOrg,
                includeRelationships,
                batchSize,
                mode,
                transferMode: transferMode
            };
            
            // Collect external ID mappings if needed
            if (includeRelationships && transferMode === 'upsert') {
                const selectedObjects = Array.from(document.querySelectorAll('#objectTypes input[type="checkbox"]:checked'))
                    .map(cb => cb.value);
                const externalIdMapping = {};
                let hasEmptyFields = false;
                
                selectedObjects.forEach(obj => {
                    const inputId = 'extId_' + obj.replace(/[^a-zA-Z0-9]/g, '_');
                    const input = document.getElementById(inputId);
                    if (input && input.value.trim()) {
                        externalIdMapping[obj] = input.value.trim();
                    } else {
                        hasEmptyFields = true;
                        addToLog('Missing external ID field for ' + obj, 'error');
                    }
                });
                
                if (hasEmptyFields) {
                    return;
                }
                
                transferOptions.externalIdMapping = externalIdMapping;
            }
            
            if (mode === 'custom') {
                const query = document.getElementById('soqlQuery').value.trim();
                if (!query) {
                    addToLog('Please enter a SOQL query', 'error');
                    return;
                }
                transferOptions.customQuery = query;
            } else {
                const selectedObjects = Array.from(document.querySelectorAll('#objectTypes input[type="checkbox"]:checked'))
                    .map(cb => cb.value);
                
                if (selectedObjects.length === 0) {
                    addToLog('Please select at least one object to transfer', 'error');
                    return;
                }
                
                // Collect record limits for selected objects
                const recordLimits = {};
                selectedObjects.forEach(obj => {
                    const optionsDiv = document.getElementById(\`options-\${obj.replace(/[^a-zA-Z0-9]/g, '_')}\`);
                    const select = optionsDiv.querySelector('.record-limit');
                    const customInput = optionsDiv.querySelector('.custom-limit');
                    
                    if (select.value === 'custom' && customInput.value) {
                        recordLimits[obj] = parseInt(customInput.value);
                    } else if (select.value !== 'all') {
                        recordLimits[obj] = parseInt(select.value);
                    }
                });
                
                transferOptions.objectTypes = selectedObjects;
                transferOptions.recordLimits = recordLimits;
            }
            
            vscode.postMessage({
                type: 'startTransfer',
                options: transferOptions
            });
        }

        function addToLog(message, type = 'info') {
            const log = document.getElementById('log');
            const timestamp = new Date().toLocaleTimeString();
            const className = type === 'error' ? 'error' : type === 'success' ? 'success' : '';

            // Normalize message to string
            let text = '';
            if (typeof message === 'string') {
                text = message;
            } else {
                try {
                    text = JSON.stringify(message, null, 2);
                } catch (e) {
                    text = String(message);
                }
            }
            
            const isError = className === 'error';
            
            // Create main log entry div
            const logEntry = document.createElement('div');
            logEntry.className = className;
            
            // Create header with timestamp
            const header = text.split('\\n')[0];
            const headerText = '[' + timestamp + '] ' + (isError ? 'Error: ' : '') + header;
            
            if (isError && text.includes('\\n')) {
                // For multi-line errors, create collapsible structure
                const headerSpan = document.createElement('span');
                headerSpan.textContent = headerText;
                logEntry.appendChild(headerSpan);
                
                // Add copy button
                const copyBtn = document.createElement('button');
                copyBtn.textContent = 'Copy';
                copyBtn.style.marginLeft = '8px';
                copyBtn.style.padding = '2px 6px';
                copyBtn.style.fontSize = '11px';
                copyBtn.addEventListener('click', function() {
                    navigator.clipboard.writeText(text);
                });
                logEntry.appendChild(copyBtn);
                
                // Add details section
                const details = document.createElement('details');
                details.style.marginTop = '4px';
                const summary = document.createElement('summary');
                summary.textContent = 'Details';
                details.appendChild(summary);
                
                const pre = document.createElement('pre');
                pre.style.whiteSpace = 'pre-wrap';
                pre.style.margin = '8px 0';
                pre.style.padding = '8px';
                pre.style.backgroundColor = 'var(--vscode-textCodeBlock-background)';
                pre.style.border = '1px solid var(--vscode-panel-border)';
                pre.style.borderRadius = '4px';
                pre.textContent = text;
                details.appendChild(pre);
                
                logEntry.appendChild(details);
            } else {
                // For simple messages, just show the text
                logEntry.textContent = headerText;
            }
            
            log.appendChild(logEntry);
            log.scrollTop = log.scrollHeight;
        }

        // Initialize
        console.log('Webview initializing, requesting orgs...');
        addToLog('Loading authenticated orgs...');
        vscode.postMessage({ type: 'getOrgs' });
    </script>
</body>
</html>`;
    }

    private async _validateQuery(query: string, sourceOrgUsername: string) {
        try {
            // Basic SOQL validation first
            const queryUpper = query.toUpperCase();
            let error = '';

            if (!query.trim()) {
                this._panel.webview.postMessage({
                    type: 'queryValidation',
                    isValid: false,
                    error: 'Query cannot be empty'
                });
                return;
            }
            
            if (!queryUpper.startsWith('SELECT')) {
                this._panel.webview.postMessage({
                    type: 'queryValidation',
                    isValid: false,
                    error: 'Query must start with SELECT keyword'
                });
                return;
            }
            
            if (!queryUpper.includes(' FROM ')) {
                this._panel.webview.postMessage({
                    type: 'queryValidation',
                    isValid: false,
                    error: 'Query must include FROM clause to specify an object'
                });
                return;
            }
            
            if (queryUpper.includes('DELETE') || queryUpper.includes('UPDATE') || queryUpper.includes('INSERT')) {
                this._panel.webview.postMessage({
                    type: 'queryValidation',
                    isValid: false,
                    error: 'Only SELECT queries are allowed for data transfer'
                });
                return;
            }

            // Validate against Salesforce by executing a limited query
            const orgs = this.orgManager.getOrgs();
            const sourceOrg = orgs.find(org => org.username === sourceOrgUsername);
            
            if (!sourceOrg) {
                this._panel.webview.postMessage({
                    type: 'queryValidation',
                    isValid: false,
                    error: 'Please select a source org first'
                });
                return;
            }

            // Get access token
            const accessToken = await this.orgManager.getAccessToken(sourceOrg.username);
            if (!accessToken) {
                this._panel.webview.postMessage({
                    type: 'queryValidation',
                    isValid: false,
                    error: 'Could not retrieve access token. Please re-authenticate the org.'
                });
                return;
            }

            sourceOrg.accessToken = accessToken;

            // Initialize connection
            const tempTargetOrg = { ...sourceOrg };
            await this.dataTransferService.initializeConnections(sourceOrg, tempTargetOrg);

            // Execute the query with LIMIT 1 to validate syntax and permissions
            let validationQuery = query.trim();
            
            // Remove existing LIMIT clause and add LIMIT 1 for validation
            // Use case-insensitive regex to remove any LIMIT clause at the end
            validationQuery = validationQuery.replace(/\s+LIMIT\s+\d+\s*$/i, '');
            validationQuery += ' LIMIT 1';

            // Try to execute the query
            await this.dataTransferService.executeQuery(validationQuery);

            // If we get here, the query is valid
            this._panel.webview.postMessage({
                type: 'queryValidation',
                isValid: true,
                error: ''
            });

        } catch (error: any) {
            // Parse Salesforce error message to provide helpful feedback
            let errorMessage = 'Query validation failed';
            
            if (error && typeof error === 'object') {
                const errorStr = error.message || JSON.stringify(error);
                
                // Extract meaningful error messages from Salesforce responses
                if (errorStr.includes('INVALID_FIELD')) {
                    const fieldMatch = errorStr.match(/No such column '([^']+)'/);
                    if (fieldMatch) {
                        errorMessage = `Invalid field: '${fieldMatch[1]}' does not exist on the object or you don't have access to it`;
                    } else {
                        errorMessage = 'One or more fields in the query are invalid or inaccessible';
                    }
                } else if (errorStr.includes('INVALID_TYPE')) {
                    errorMessage = 'The object specified in FROM clause does not exist or is not accessible';
                } else if (errorStr.includes('MALFORMED_QUERY')) {
                    errorMessage = 'Query syntax is malformed. Please check your SOQL syntax';
                } else if (errorStr.includes('No such column')) {
                    const fieldMatch = errorStr.match(/No such column '([^']+)'/);
                    if (fieldMatch) {
                        errorMessage = `Field '${fieldMatch[1]}' does not exist or is not accessible`;
                    }
                } else if (errorStr.includes('unexpected token')) {
                    const tokenMatch = errorStr.match(/unexpected token: '([^']+)'/);
                    if (tokenMatch) {
                        errorMessage = `Syntax error: unexpected token '${tokenMatch[1]}'`;
                    } else {
                        errorMessage = 'Syntax error in query. Please check your SOQL syntax';
                    }
                } else if (errorStr.includes('401')) {
                    errorMessage = 'Authentication failed. Please re-authenticate your org';
                } else if (errorStr.includes('403')) {
                    errorMessage = 'Access denied. You may not have permission to query this object';
                } else {
                    // Try to extract any meaningful error message
                    const messageMatch = errorStr.match(/message["']?:\s*["']([^"']+)["']/);
                    if (messageMatch) {
                        errorMessage = messageMatch[1];
                    } else if (errorStr.length < 200) {
                        errorMessage = errorStr;
                    }
                }
            }

            this._panel.webview.postMessage({
                type: 'queryValidation',
                isValid: false,
                error: errorMessage
            });
        }
    }

    private buildCountQuery(originalQuery: string): string {
        // Convert SELECT ... FROM Object to SELECT COUNT() FROM Object
        const queryUpper = originalQuery.toUpperCase();
        const fromIndex = queryUpper.indexOf(' FROM ');
        if (fromIndex === -1) {
            throw new Error('Invalid query: missing FROM clause');
        }

        const fromPart = originalQuery.substring(fromIndex);
        const whereIndex = queryUpper.indexOf(' WHERE ');
        const orderByIndex = queryUpper.indexOf(' ORDER BY ');
        const limitIndex = queryUpper.indexOf(' LIMIT ');

        let countQuery = 'SELECT COUNT()' + fromPart;

        // Remove ORDER BY and LIMIT clauses for count query, but keep WHERE
        if (limitIndex > -1) {
            countQuery = countQuery.substring(0, countQuery.toUpperCase().indexOf(' LIMIT '));
        }
        if (orderByIndex > -1 && (limitIndex === -1 || orderByIndex < limitIndex)) {
            countQuery = countQuery.substring(0, countQuery.toUpperCase().indexOf(' ORDER BY '));
        }

        return countQuery;
    }

    private async _previewQuery(query: string, sourceOrgUsername?: string) {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Previewing SOQL query...",
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ increment: 20, message: "Validating query..." });

                // Refresh orgs to ensure we have the latest data
                const orgs = await this.orgManager.refreshOrgs();
                
                console.log('Preview query - Available orgs:', orgs.length);
                console.log('Preview query - Source org username:', sourceOrgUsername);
                
                // Find the selected source org, or fall back to first org
                let sourceOrg;
                if (sourceOrgUsername) {
                    sourceOrg = orgs.find(org => org.username === sourceOrgUsername);
                    if (!sourceOrg) {
                        throw new Error(`Source org not found: ${sourceOrgUsername}`);
                    }
                } else {
                    sourceOrg = orgs[0];
                    if (!sourceOrg) {
                        throw new Error('No source org available');
                    }
                }
                
                console.log('Preview query - Using source org:', sourceOrg.username);

                progress.report({ increment: 40, message: "Getting access token..." });

                const accessToken = await this.orgManager.getAccessToken(sourceOrg.username);
                if (!accessToken) {
                    throw new Error(`Could not retrieve access token for ${sourceOrg.alias || sourceOrg.username}. Please re-authenticate the org using: sf org login web --alias ${sourceOrg.alias || sourceOrg.username}`);
                }

                // Validate the token
                const isTokenValid = await this.orgManager.validateAccessToken(sourceOrg.instanceUrl, accessToken);
                if (!isTokenValid) {
                    throw new Error(`Access token for ${sourceOrg.alias || sourceOrg.username} is invalid or expired. Please re-authenticate using: sf org login web --alias ${sourceOrg.alias || sourceOrg.username}`);
                }

                sourceOrg.accessToken = accessToken;

                progress.report({ increment: 60, message: "Executing query..." });

                // Initialize connection and execute query
                const tempTargetOrg = { ...sourceOrg };
                await this.dataTransferService.initializeConnections(sourceOrg, tempTargetOrg);

                // Execute the user's query as-is (respecting their LIMIT clause)
                const result = await this.dataTransferService.executeQuery(query.trim());

                progress.report({ increment: 100 });

                this._panel.webview.postMessage({
                    type: 'queryPreview',
                    data: result
                });

                const recordCount = result.records?.length || 0;
                const totalSize = result.totalSize || recordCount;
                vscode.window.showInformationMessage(`Query preview completed: Retrieved ${recordCount} records (Total available: ${totalSize})`);

            } catch (error) {
                console.error('Query preview error:', error);
                vscode.window.showErrorMessage(`Query preview failed: ${error}`);
                this._panel.webview.postMessage({
                    type: 'error',
                    data: `Query preview failed: ${error}`
                });
            }
        });
    }

    public dispose() {
        DataTransferPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}