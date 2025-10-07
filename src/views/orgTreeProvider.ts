import * as vscode from 'vscode';
import { SalesforceOrg, SalesforceOrgManager } from '../salesforce/orgManager';

export class OrgTreeItem extends vscode.TreeItem {
    constructor(
        public readonly org: SalesforceOrg,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(org.alias || org.username, collapsibleState);
        
        this.tooltip = `${org.username} (${org.orgId})`;
        this.description = org.instanceUrl;
        this.contextValue = 'salesforceOrg';
        
        if (org.isDefault) {
            this.iconPath = new vscode.ThemeIcon('star-full');
        } else {
            this.iconPath = new vscode.ThemeIcon('organization');
        }
    }
}

export class SalesforceOrgProvider implements vscode.TreeDataProvider<OrgTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<OrgTreeItem | undefined | null | void> = new vscode.EventEmitter<OrgTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<OrgTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private orgManager: SalesforceOrgManager) {
        this.orgManager.onDidChangeOrgs(() => {
            this._onDidChangeTreeData.fire();
        });
    }

    refresh(): void {
        this.orgManager.refreshOrgs();
    }

    getTreeItem(element: OrgTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: OrgTreeItem): Thenable<OrgTreeItem[]> {
        if (!element) {
            // Return root level items (orgs)
            const orgs = this.orgManager.getOrgs();
            return Promise.resolve(
                orgs.map(org => new OrgTreeItem(org, vscode.TreeItemCollapsibleState.None))
            );
        }
        
        return Promise.resolve([]);
    }
}