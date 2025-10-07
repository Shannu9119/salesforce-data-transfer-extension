import * as vscode from 'vscode';
import { SalesforceOrgManager } from './salesforce/orgManager';
import { DataTransferService } from './salesforce/dataTransferService';
import { SalesforceOrgProvider } from './views/orgTreeProvider';
import { DataTransferPanel } from './webview/dataTransferPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('Salesforce Data Transfer extension is now active!');

    // Initialize services
    const orgManager = new SalesforceOrgManager();
    const dataTransferService = new DataTransferService();

    // Create tree view provider
    const orgProvider = new SalesforceOrgProvider(orgManager);
    vscode.window.createTreeView('sf-data-transfer-orgs', {
        treeDataProvider: orgProvider,
        showCollapseAll: true
    });

    // Register commands
    const openTransferPanel = vscode.commands.registerCommand('sf-data-transfer.openTransferPanel', () => {
        DataTransferPanel.createOrShow(context.extensionUri, orgManager, dataTransferService);
    });

    const refreshOrgs = vscode.commands.registerCommand('sf-data-transfer.refreshOrgs', () => {
        orgProvider.refresh();
        vscode.window.showInformationMessage('Refreshing Salesforce orgs...');
    });

    const selectSourceOrg = vscode.commands.registerCommand('sf-data-transfer.selectSourceOrg', async () => {
        const orgs = orgManager.getOrgs();
        if (orgs.length === 0) {
            vscode.window.showWarningMessage('No authenticated Salesforce orgs found. Please authenticate first using Salesforce CLI.');
            return;
        }

        const items = orgs.map(org => ({
            label: org.alias || org.username,
            description: org.username,
            detail: org.instanceUrl
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select source org for data transfer'
        });

        if (selected) {
            vscode.window.showInformationMessage(`Selected source org: ${selected.label}`);
        }
    });

    const selectTargetOrg = vscode.commands.registerCommand('sf-data-transfer.selectTargetOrg', async () => {
        const orgs = orgManager.getOrgs();
        if (orgs.length === 0) {
            vscode.window.showWarningMessage('No authenticated Salesforce orgs found. Please authenticate first using Salesforce CLI.');
            return;
        }

        const items = orgs.map(org => ({
            label: org.alias || org.username,
            description: org.username,
            detail: org.instanceUrl
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select target org for data transfer'
        });

        if (selected) {
            vscode.window.showInformationMessage(`Selected target org: ${selected.label}`);
        }
    });

    // Add all commands to subscriptions
    context.subscriptions.push(
        openTransferPanel,
        refreshOrgs,
        selectSourceOrg,
        selectTargetOrg
    );

    // Initialize orgs on activation
    orgManager.refreshOrgs().then(() => {
        console.log('Salesforce orgs loaded successfully');
    }).catch(error => {
        console.error('Failed to load Salesforce orgs:', error);
    });
}

export function deactivate() {
    // Cleanup code here if needed
}
