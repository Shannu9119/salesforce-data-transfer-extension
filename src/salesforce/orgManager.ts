import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface SalesforceOrg {
    alias?: string;
    username: string;
    orgId: string;
    instanceUrl: string;
    accessToken?: string;
    isDefault?: boolean;
}

export class SalesforceOrgManager {
    private _onDidChangeOrgs: vscode.EventEmitter<SalesforceOrg[]> = new vscode.EventEmitter<SalesforceOrg[]>();
    public readonly onDidChangeOrgs: vscode.Event<SalesforceOrg[]> = this._onDidChangeOrgs.event;
    
    private orgs: SalesforceOrg[] = [];

    constructor() {
        this.refreshOrgs();
    }

    public async refreshOrgs(): Promise<SalesforceOrg[]> {
        try {
            // First try the updated CLI approach
            try {
                const osModule2 = require('os');
                const sfPath = `"${osModule2.homedir()}\\AppData\\Roaming\\npm\\sf.cmd"`;
                
                await execAsync(`${sfPath} --version`);
                const { stdout } = await execAsync(`${sfPath} org list --json`);
                const result = JSON.parse(stdout);
                
                if (result.status === 0 && result.result) {
                    this.orgs = result.result.nonScratchOrgs?.map((org: any) => ({
                        alias: org.alias,
                        username: org.username,
                        orgId: org.orgId,
                        instanceUrl: org.instanceUrl,
                        isDefault: org.isDefaultUsername
                    })) || [];
                    
                    // Add scratch orgs if any
                    if (result.result.scratchOrgs) {
                        const scratchOrgs = result.result.scratchOrgs.map((org: any) => ({
                            alias: org.alias,
                            username: org.username,
                            orgId: org.orgId,
                            instanceUrl: org.instanceUrl,
                            isDefault: false
                        }));
                        this.orgs.push(...scratchOrgs);
                    }
                }
            } catch (cliError) {
                // Fallback: Read from .sfdx configuration files directly
                console.log('CLI failed, trying fallback approach...');
                this.orgs = await this.readOrgsFromConfig();
            }
            
            this._onDidChangeOrgs.fire(this.orgs);
            
            // Set context for when orgs are available
            vscode.commands.executeCommand('setContext', 'sf-data-transfer:hasOrgs', this.orgs.length > 0);
            
            return this.orgs;
        } catch (error) {
            console.error('Error refreshing Salesforce orgs:', error);
            vscode.window.showErrorMessage('Failed to get Salesforce orgs. Make sure Salesforce CLI is installed and you have authenticated orgs.');
            return [];
        }
    }

    private async readOrgsFromConfig(): Promise<SalesforceOrg[]> {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        
        try {
            const sfdxDir = path.join(os.homedir(), '.sfdx');
            const aliasFile = path.join(sfdxDir, 'alias.json');
            
            if (!fs.existsSync(aliasFile)) {
                return [];
            }
            
            const aliasContent = fs.readFileSync(aliasFile, 'utf8');
            const aliases = JSON.parse(aliasContent);
            
            const orgs: SalesforceOrg[] = [];
            
            if (aliases.orgs) {
                for (const [alias, username] of Object.entries(aliases.orgs)) {
                    // Try to read org info from individual org files
                    const orgFiles = fs.readdirSync(sfdxDir)
                        .filter((file: string) => file.includes(username as string) && file.endsWith('.json'));
                    
                    if (orgFiles.length > 0) {
                        try {
                            const orgFile = path.join(sfdxDir, orgFiles[0]);
                            const orgContent = fs.readFileSync(orgFile, 'utf8');
                            const orgInfo = JSON.parse(orgContent);
                            
                            orgs.push({
                                alias: alias,
                                username: username as string,
                                orgId: orgInfo.orgId || 'unknown',
                                instanceUrl: orgInfo.instanceUrl || orgInfo.loginUrl || 'https://login.salesforce.com',
                                isDefault: false // We'll need to check config for default
                            });
                        } catch (fileError) {
                            // If we can't read org details, create basic entry
                            orgs.push({
                                alias: alias,
                                username: username as string,
                                orgId: 'unknown',
                                instanceUrl: 'https://login.salesforce.com',
                                isDefault: false
                            });
                        }
                    }
                }
            }
            
            return orgs;
        } catch (error) {
            console.error('Error reading org config:', error);
            return [];
        }
    }

    public getOrgs(): SalesforceOrg[] {
        return this.orgs;
    }

    public async getAccessToken(username: string): Promise<string | undefined> {
        try {
            // Method 1: Try to get a fresh token using updated CLI
            console.log(`Getting access token for ${username}...`);
            
            const osModule = require('os');
            const sfPath = `"${osModule.homedir()}\\AppData\\Roaming\\npm\\sf.cmd"`;
            
            try {
                // Use sf org display to get fresh token info
                const { stdout } = await execAsync(`${sfPath} org display --target-org ${username} --json`);
                const result = JSON.parse(stdout);
                
                if (result.status === 0 && result.result?.accessToken) {
                    console.log('Got fresh access token from CLI');
                    return result.result.accessToken;
                }
            } catch (cliError) {
                console.log('CLI org display failed, trying alternative methods...');
            }

            // Method 2: Try using force:org:display (legacy command)
            try {
                const { stdout } = await execAsync(`sfdx force:org:display --targetusername ${username} --json`);
                const result = JSON.parse(stdout);
                
                if (result.status === 0 && result.result?.accessToken) {
                    console.log('Got access token from legacy CLI command');
                    return result.result.accessToken;
                }
            } catch (legacyError) {
                console.log('Legacy CLI command failed, trying org files...');
            }

            // Method 3: Try to refresh the session and get new token
            try {
                // First try to "open" the org to refresh the session
                await execAsync(`sf org open --target-org ${username} --url-only`);
                
                // Then try to get the token again
                const { stdout } = await execAsync(`sf org display --target-org ${username} --json`);
                const result = JSON.parse(stdout);
                
                if (result.status === 0 && result.result?.accessToken) {
                    console.log('Got access token after session refresh');
                    return result.result.accessToken;
                }
            } catch (refreshError) {
                console.log('Session refresh failed, trying direct file access...');
            }

            // Method 4: Read from config files and try to use refresh token
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            
            const sfdxDir = path.join(os.homedir(), '.sfdx');
            const orgFiles = fs.readdirSync(sfdxDir)
                .filter((file: string) => file.includes(username) && file.endsWith('.json'));
            
            if (orgFiles.length > 0) {
                const orgFile = path.join(sfdxDir, orgFiles[0]);
                const orgContent = fs.readFileSync(orgFile, 'utf8');
                const orgInfo = JSON.parse(orgContent);
                
                // If we have a refresh token, try to use it to get a new access token
                if (orgInfo.refreshToken && orgInfo.clientId) {
                    console.log('Attempting to refresh token using stored refresh token...');
                    return await this.refreshAccessToken(orgInfo);
                }
                
                // As last resort, try the stored access token (might be expired)
                const storedToken = orgInfo.accessToken;
                if (storedToken) {
                    console.log('Using stored access token (may be expired)');
                    return storedToken;
                }
            }

        } catch (error) {
            console.error('All access token methods failed:', error);
        }
        
        return undefined;
    }

    private async refreshAccessToken(orgInfo: any): Promise<string | undefined> {
        try {
            // Use the OAuth2 refresh token flow
            const tokenEndpoint = orgInfo.loginUrl ? 
                `${orgInfo.loginUrl}/services/oauth2/token` : 
                'https://login.salesforce.com/services/oauth2/token';

            const params = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: orgInfo.refreshToken,
                client_id: orgInfo.clientId || 'PlatformCLI'
            });

            const response = await fetch(tokenEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: params.toString()
            });

            if (response.ok) {
                const tokenData = await response.json() as any;
                console.log('Successfully refreshed access token');
                return tokenData.access_token;
            } else {
                const errorText = await response.text();
                console.error('Token refresh failed:', response.status, errorText);
            }
        } catch (error) {
            console.error('Error refreshing token:', error);
        }
        
        return undefined;
    }

    public async validateAccessToken(instanceUrl: string, accessToken: string): Promise<boolean> {
        try {
            const url = `${instanceUrl}/services/data/v59.0/`;
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });
            
            return response.ok;
        } catch (error) {
            console.error('Error validating access token:', error);
            return false;
        }
    }
}