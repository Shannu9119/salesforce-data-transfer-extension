import * as vscode from 'vscode';
import { SalesforceOrg } from './orgManager';

// Salesforce REST API client
class SalesforceRestClient {
    private instanceUrl: string;
    private accessToken: string;
    private apiVersion: string = '59.0';

    constructor(instanceUrl: string, accessToken: string) {
        this.instanceUrl = instanceUrl.endsWith('/') ? instanceUrl.slice(0, -1) : instanceUrl;
        this.accessToken = accessToken;
    }

    private async makeRequest(endpoint: string, options: any = {}): Promise<any> {
        const url = `${this.instanceUrl}/services/data/v${this.apiVersion}${endpoint}`;
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
                ...options.headers
            },
            ...options
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorMessage = `Salesforce API error: ${response.status} ${response.statusText}`;
            
            if (response.status === 401) {
                errorMessage += ' - Access token is invalid or expired. Please re-authenticate your org using Salesforce CLI.';
            } else {
                errorMessage += ` - ${errorText}`;
            }
            
            throw new Error(errorMessage);
        }

        return response.json();
    }

    async describeGlobal(): Promise<any> {
        return this.makeRequest('/sobjects/');
    }

    async describe(sobjectType: string): Promise<any> {
        return this.makeRequest(`/sobjects/${sobjectType}/describe/`);
    }

    async query(soql: string): Promise<any> {
        const encodedQuery = encodeURIComponent(soql);
        return this.makeRequest(`/query/?q=${encodedQuery}`);
    }

    async create(sobjectType: string, records: any[]): Promise<any> {
        if (records.length === 1) {
            return this.makeRequest(`/sobjects/${sobjectType}/`, {
                method: 'POST',
                body: JSON.stringify(records[0])
            });
        } else {
            // Use composite API for multiple records
            const compositeRequest = {
                allOrNone: false,
                records: records.map((record, index) => ({
                    attributes: { type: sobjectType },
                    ...record
                }))
            };

            return this.makeRequest(`/composite/sobjects/`, {
                method: 'POST',
                body: JSON.stringify(compositeRequest)
            });
        }
    }

    async identity(): Promise<any> {
        return this.makeRequest('/');
    }
}

export interface DataTransferOptions {
    sourceOrg: SalesforceOrg;
    targetOrg: SalesforceOrg;
    objectTypes?: string[];
    includeRelationships: boolean;
    batchSize: number;
    // Optional: record limits per object and custom query
    recordLimits?: Record<string, number>;
    customQuery?: string;
    // External ID configuration for upsert operations
    externalIdMapping?: Record<string, string>; // objectType -> fieldName mapping
    transferMode: 'insert' | 'upsert'; // Default should be 'insert'
}

export interface TransferResult {
    success: boolean;
    recordsTransferred: number;
    errors: string[];
}

export class DataTransferService {
    private sourceConn: SalesforceRestClient | null = null;
    private targetConn: SalesforceRestClient | null = null;

    private stringifyErrors(err: any): string {
        if (typeof err === 'string') { return err; }
        if (err instanceof Error) { return err.message; }
        if (Array.isArray(err)) {
            // For arrays of similar errors, consolidate them
            const errors = err.map(e => this.stringifyErrors(e)).filter(Boolean);
            const uniqueErrors = [...new Set(errors)]; // Remove duplicates
            if (uniqueErrors.length === 1 && errors.length > 1) {
                return `${uniqueErrors[0]} (occurred ${errors.length} times)`;
            }
            return uniqueErrors.join('; ');
        }
        if (err && typeof err === 'object') {
            const message = (err as any).message;
            const status = (err as any).statusCode || (err as any).status;
            const fields = (err as any).fields;
            const pieces: string[] = [];
            if (message) { 
                // Clean up repetitive Salesforce errors
                let cleanMessage = String(message);
                if (cleanMessage.includes('Field name provided') && cleanMessage.length > 200) {
                    const fieldMatches = cleanMessage.match(/(\w+__c): Field name provided/g);
                    if (fieldMatches && fieldMatches.length > 1) {
                        const affectedFields = fieldMatches.map(m => m.split(':')[0]).join(', ');
                        cleanMessage = `Multiple fields have External ID/indexing issues: ${affectedFields}. Check field configurations.`;
                    }
                }
                pieces.push(cleanMessage);
            }
            if (status) { pieces.push(`code=${status}`); }
            if (Array.isArray(fields) && fields.length) { pieces.push(`fields=${fields.join(',')}`); }
            if (pieces.length) { return pieces.join(' '); }
            try { return JSON.stringify(err); } catch { return String(err); }
        }
        return String(err);
    }

    /**
     * Remove system fields that should not be inserted/updated
     */
    private removeSystemFields(record: any): void {
        // System fields that are automatically managed by Salesforce
        const systemFields = [
            'Id',
            'attributes',
            'CreatedDate',
            'CreatedById',
            'LastModifiedDate', 
            'LastModifiedById',
            'SystemModstamp',
            'LastActivityDate',
            'LastViewedDate',
            'LastReferencedDate',
            'Owner', // This should not be inserted - use OwnerId if needed
            'IsDeleted',
            'MasterRecordId', // For merged records
            'ConnectionReceivedId',
            'ConnectionSentId',
            // Chatter/Feed related
            'PhotoUrl'
        ];

        systemFields.forEach(field => {
            if (record.hasOwnProperty(field)) {
                delete record[field];
            }
        });

        // Remove any field ending with '__pc' (person account fields that are read-only)
        Object.keys(record).forEach(key => {
            if (key.endsWith('__pc')) {
                delete record[key];
            }
        });

        // Remove fields that look like system timestamps
        Object.keys(record).forEach(key => {
            if (key.match(/(Date|Time)$/i) && typeof record[key] === 'string') {
                // Keep business date fields but remove system timestamps
                const systemTimestamps = ['LastLoginDate', 'LastPasswordChangeDate', 'EmailBouncedDate'];
                if (systemTimestamps.includes(key)) {
                    delete record[key];
                }
            }
        });
    }

    /**
     * Check if a field should be included when fetching records for insert
     */
    private isInsertableField(field: any): boolean {
        // System fields that should never be queried for insert
        const systemFieldNames = [
            'Owner', // Use OwnerId instead
            'CreatedDate', 'CreatedById',
            'LastModifiedDate', 'LastModifiedById', 
            'SystemModstamp',
            'LastActivityDate',
            'LastViewedDate', 
            'LastReferencedDate',
            'IsDeleted',
            'MasterRecordId',
            'PhotoUrl'
        ];

        if (systemFieldNames.includes(field.name)) {
            return false;
        }

        // Skip person account fields (read-only)
        if (field.name.endsWith('__pc')) {
            return false;
        }

        // Skip calculated fields
        if (field.calculated) {
            return false;
        }

        // Skip formula fields (they're calculated)
        if (field.type === 'formula') {
            return false;
        }

        return true;
    }

    public async initializeConnections(sourceOrg: SalesforceOrg, targetOrg: SalesforceOrg): Promise<void> {
        try {
            if (!sourceOrg.accessToken || !targetOrg.accessToken) {
                throw new Error('Access tokens are required for both source and target orgs');
            }

            // Initialize source connection
            this.sourceConn = new SalesforceRestClient(
                sourceOrg.instanceUrl,
                sourceOrg.accessToken
            );

            // Initialize target connection
            this.targetConn = new SalesforceRestClient(
                targetOrg.instanceUrl,
                targetOrg.accessToken
            );

            // Test connections
            await this.sourceConn.identity();
            await this.targetConn.identity();
            
        } catch (error) {
            throw new Error(`Failed to initialize Salesforce connections: ${error}`);
        }
    }

    public async transferData(options: DataTransferOptions): Promise<TransferResult> {
        if (!this.sourceConn || !this.targetConn) {
            throw new Error('Connections not initialized');
        }

        // Set default transfer mode if not specified
        if (!options.transferMode) {
            options.transferMode = 'insert';
        }

        const result: TransferResult = {
            success: false,
            recordsTransferred: 0,
            errors: []
        };

        try {
            // If a custom query is provided, handle that path
            if (options.customQuery && options.customQuery.trim()) {
                await this.transferByQuery(options.customQuery, options, result);
                result.success = result.errors.length === 0;
                return result;
            }

            if (!options.objectTypes || !Array.isArray(options.objectTypes)) {
                throw new Error('No object types provided for transfer');
            }

            for (const objectType of options.objectTypes) {
                await this.transferObjectRecords(objectType, options, result);
            }

            result.success = result.errors.length === 0;
            return result;

        } catch (error) {
            result.errors.push(`Transfer failed: ${error}`);
            return result;
        }
    }

    private parseFromObject(soql: string): string | null {
        // A simple regex to capture the first token after FROM (handling optional alias and newlines)
        // Example: SELECT ... FROM Account a WHERE ...
        const m = /\bFROM\s+([a-zA-Z0-9_]+)\b/i.exec(soql);
        return m ? m[1] : null;
    }

    private async transferByQuery(soql: string, options: DataTransferOptions, result: TransferResult): Promise<void> {
        if (!this.sourceConn || !this.targetConn) {
            throw new Error('Connections not initialized');
        }

        const objectType = this.parseFromObject(soql);
        if (!objectType) {
            throw new Error('Unable to determine object type from SOQL query');
        }

        try {
            const queryResult = await this.sourceConn.query(soql);
            const records: any[] = queryResult.records || [];

            if (records.length === 0) {
                return;
            }

            const metadata = await this.sourceConn.describe(objectType);

            // Process in batches
            const batchSize = options.batchSize || 200;
            for (let i = 0; i < records.length; i += batchSize) {
                const batch = records.slice(i, i + batchSize);

                // Clean records for insertion
                const cleanedBatch = batch.map((record: any) => {
                    const cleaned: any = { ...record };
                    // Remove system fields that are automatically managed by Salesforce
                    this.removeSystemFields(cleaned);
                    return cleaned;
                });

                // Relationship handling (ensure parents exist and map Ids)
                if (options.includeRelationships) {
                    const idMap = await this.ensureParentRecordsExistNew(objectType, metadata, batch, result, options);
                    const referenceFields = metadata.fields.filter((f: any) => f.type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo.length > 0);
                    cleanedBatch.forEach((cleaned: any, idx: number) => {
                        const original = batch[idx];
                        for (const ref of referenceFields) {
                            const srcId = original[ref.name];
                            if (srcId && idMap[srcId]) {
                                cleaned[ref.name] = idMap[srcId];
                            }
                        }
                    });
                }

                // Insert into target
                const insertResult = await this.targetConn.create(objectType, cleanedBatch);

                if (Array.isArray(insertResult)) {
                    const successCount = insertResult.filter(r => r.success).length;
                    result.recordsTransferred += successCount;
                    const failures = insertResult.filter(r => !r.success);
                    failures.forEach(failure => {
                        const errStr = this.stringifyErrors((failure as any).errors);
                        result.errors.push(`${objectType}: ${errStr || 'Unknown error'}`);
                    });
                } else if (insertResult.success) {
                    result.recordsTransferred += 1;
                } else {
                    const errStr = this.stringifyErrors((insertResult as any).errors);
                    result.errors.push(`${objectType}: ${errStr || 'Unknown error'}`);
                }
            }

        } catch (error) {
            result.errors.push(`Error transferring by query for ${objectType}: ${this.stringifyErrors(error)}`);
        }
    }

    private async transferObjectRecords(
        objectType: string, 
        options: DataTransferOptions, 
        result: TransferResult
    ): Promise<void> {
        if (!this.sourceConn || !this.targetConn) {
            throw new Error('Connections not initialized');
        }

        try {
            // Get object metadata to understand fields and relationships
            const metadata = await this.sourceConn.describe(objectType);
            
            // Build SOQL query with writable fields
            const baseFields = metadata.fields
                .filter((field: any) => field.createable || field.updateable)
                .map((field: any) => field.name)
                .join(', ');

            // Add relationship fields if requested
            let relationshipFields = '';
            if (options.includeRelationships) {
                const relationshipFieldNames = metadata.fields
                    .filter((field: any) => field.type === 'reference' && field.relationshipName)
                    .map((field: any) => field.relationshipName)
                    .join(', ');
                
                if (relationshipFieldNames) {
                    relationshipFields = `, ${relationshipFieldNames}`;
                }
            }

            // Apply record limit if configured for this object
            const limitClause = options.recordLimits && options.recordLimits[objectType]
                ? ` LIMIT ${options.recordLimits[objectType]}`
                : '';

            const fields = baseFields; // keep naming stable for downstream
            const query = `SELECT ${fields}${relationshipFields} FROM ${objectType}${limitClause}`;
            
            // Execute query and get records
            const queryResult = await this.sourceConn.query(query);
            const records = queryResult.records;

            if (records.length === 0) {
                return;
            }

            // Process records in batches
            const batchSize = options.batchSize || 200;
            for (let i = 0; i < records.length; i += batchSize) {
                const batch = records.slice(i, i + batchSize);
                
                // Clean records for insertion (remove Id, system fields, etc.)
                const cleanedBatch = batch.map((record: any) => {
                    const cleaned: any = { ...record };
                    // Remove system fields that are automatically managed by Salesforce
                    this.removeSystemFields(cleaned);
                    return cleaned;
                });

                // If relationship handling is enabled, ensure parent records exist in target
                        if (options.includeRelationships) {
                            const idMap: Record<string, string> = await this.ensureParentRecordsExistNew(objectType, metadata, batch, result, options);
                            // Remap lookup fields on cleanedBatch using source->target Id map
                            const referenceFields = metadata.fields.filter((f: any) => f.type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo.length > 0);
                            cleanedBatch.forEach((cleaned: any, idx: number) => {
                                const original = batch[idx];
                                for (const ref of referenceFields) {
                                    const srcId = original[ref.name];
                                    if (srcId && idMap[srcId]) {
                                        cleaned[ref.name] = idMap[srcId];
                                    }
                                }
                            });
                        }

                // Insert records into target org
                const insertResult = await this.targetConn.create(objectType, cleanedBatch);
                
                // Handle results
                if (Array.isArray(insertResult)) {
                    const successCount = insertResult.filter(r => r.success).length;
                    result.recordsTransferred += successCount;
                    
                    const failures = insertResult.filter(r => !r.success);
                    failures.forEach(failure => {
                        const errStr = this.stringifyErrors((failure as any).errors);
                        result.errors.push(`${objectType}: ${errStr || 'Unknown error'}`);
                    });
                } else if (insertResult.success) {
                    result.recordsTransferred += 1;
                } else {
                    const errStr = this.stringifyErrors((insertResult as any).errors);
                    result.errors.push(`${objectType}: ${errStr || 'Unknown error'}`);
                }
            }

        } catch (error) {
            result.errors.push(`Error transferring ${objectType}: ${this.stringifyErrors(error)}`);
        }
    }

    public async getObjectTypes(): Promise<string[]> {
        if (!this.sourceConn) {
            throw new Error('Source connection not initialized');
        }

        try {
            const globalDescribe = await this.sourceConn.describeGlobal();
            
            // Filter objects to include:
            // 1. Standard objects (createable and queryable)
            // 2. Custom objects (ending with __c)
            // 3. Managed package objects (containing __ but not ending with __History, __Share, etc.)
            const objects = globalDescribe.sobjects
                .filter((sobject: any) => {
                    const name = sobject.name;
                    const isQueryable = sobject.queryable;
                    const isCreateable = sobject.createable;
                    
                    // Exclude system objects we don't want
                    const excludePatterns = [
                        '__History', '__Share', '__Feed', '__Tag', '__c2g__', 
                        '__ChangeEvent', '__e', '__mdt', '__x', '__hd'
                    ];
                    
                    const shouldExclude = excludePatterns.some(pattern => name.endsWith(pattern));
                    
                    if (shouldExclude) {
                        return false;
                    }
                    
                    // Include if it's queryable and either:
                    // 1. Standard object that's createable
                    // 2. Custom object (ends with __c)
                    // 3. Managed package object (contains namespace __)
                    return isQueryable && (
                        (isCreateable && !name.includes('__')) || // Standard objects
                        name.endsWith('__c') || // Custom objects
                        (name.includes('__') && !name.endsWith('__c')) // Managed package objects
                    );
                })
                .map((sobject: any) => ({
                    name: sobject.name,
                    label: sobject.label,
                    custom: sobject.custom,
                    namespace: this.extractNamespace(sobject.name)
                }))
                .sort((a: any, b: any) => {
                    // Sort by namespace first, then by name
                    if (a.namespace !== b.namespace) {
                        if (!a.namespace) { return -1; } // Standard objects first
                        if (!b.namespace) { return 1; }
                        return a.namespace.localeCompare(b.namespace);
                    }
                    return a.name.localeCompare(b.name);
                })
                .map((sobject: any) => sobject.name);
                
            return objects;
        } catch (error) {
            throw new Error(`Failed to get object types: ${error}`);
        }
    }

    private extractNamespace(objectName: string): string | null {
        // Extract namespace from managed package objects
        // Format: namespace__ObjectName__c or namespace__ObjectName
        const parts = objectName.split('__');
        if (parts.length >= 2 && !objectName.startsWith('__')) {
            return parts[0];
        }
        return null;
    }

    public async executeQuery(soql: string): Promise<any> {
        if (!this.sourceConn) {
            throw new Error('Source connection not initialized');
        }

        try {
            return await this.sourceConn.query(soql);
        } catch (error) {
            throw new Error(`Failed to execute query: ${error}`);
        }
    }

    public async analyzeRelationships(objectTypes: string[]): Promise<Map<string, string[]>> {
        if (!this.sourceConn) {
            throw new Error('Source connection not initialized');
        }

        const relationships = new Map<string, string[]>();

        try {
            for (const objectType of objectTypes) {
                const metadata = await this.sourceConn.describe(objectType);
                const relatedObjects = metadata.fields
                    .filter((field: any) => field.type === 'reference' && field.referenceTo)
                    .map((field: any) => field.referenceTo?.[0])
                    .filter((ref: any) => ref && objectTypes.includes(ref)) as string[];
                
                if (relatedObjects.length > 0) {
                    relationships.set(objectType, relatedObjects);
                }
            }

            return relationships;
        } catch (error) {
            throw new Error(`Failed to analyze relationships: ${error}`);
        }
    }

    /**
     * Ensure parent records referenced by lookup fields exist in target org.
     * Strategy:
     * - Identify reference fields for this object
     * - Collect unique parent Ids from the batch
     * - Fetch parent records from source (only needed key fields)
     * - Try to upsert into target using External Id fields if available; otherwise, naive insert if not existing
     */
    private async ensureParentRecordsExist(objectType: string, metadata: any, batch: any[], result: TransferResult): Promise<Record<string, string>> {
        if (!this.sourceConn || !this.targetConn) { return {}; }

        const referenceFields = metadata.fields.filter((f: any) => f.type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo.length > 0);
        if (referenceFields.length === 0) { return {}; } // Early return for no reference fields

        const sourceToTargetId: Record<string, string> = {};

        // Map of parent object -> Set of Ids
        const parentIdsByObject: Record<string, Set<string>> = {};
        for (const rec of batch) {
            for (const ref of referenceFields) {
                const idVal = rec[ref.name];
                const parentObject = ref.referenceTo[0];
                if (idVal && typeof idVal === 'string' && parentObject) {
                    parentIdsByObject[parentObject] = parentIdsByObject[parentObject] || new Set<string>();
                    parentIdsByObject[parentObject].add(idVal);
                }
            }
        }

        // For each parent object, fetch minimal fields and try to ensure existence in target
        for (const [parentObject, idSet] of Object.entries(parentIdsByObject)) {
            const ids = Array.from(idSet);
            if (ids.length === 0) { continue; }

            // Describe parent to find candidate external id fields
            const parentDescribe: any = await this.sourceConn.describe(parentObject);
            const externalIdFields: string[] = parentDescribe.fields.filter((f: any) => f.externalId).map((f: any) => f.name as string);
            const nameField: any = parentDescribe.fields.find((f: any) => f.name === 'Name');

            // Build a minimal field list for fetching from source
            const parentFetchFields = ['Id'];
            if (nameField) { parentFetchFields.push('Name'); }
            parentFetchFields.push(...externalIdFields);

            // Split ids into chunks to avoid query length limits
            const chunkSize = 1000;
            const fetchedParents: any[] = [];
            for (let i = 0; i < ids.length; i += chunkSize) {
                const chunk = ids.slice(i, i + chunkSize);
                const soql = `SELECT ${parentFetchFields.join(', ')} FROM ${parentObject} WHERE Id IN (${chunk.map(id => `'${id}'`).join(', ')})`;
                const resp = await this.sourceConn.query(soql);
                if (resp?.records?.length) { fetchedParents.push(...resp.records); }
            }

            if (fetchedParents.length === 0) { continue; }

            // Prepare lookup in target by external id (preferred)
            let existingByExternal: Record<string, string> = {};
            if (externalIdFields.length > 0) {
                const ext: string = externalIdFields[0];
                const extValues = fetchedParents.map(p => p[ext]).filter((v: any) => v !== undefined && v !== null);
                if (extValues.length > 0) {
                    for (let i = 0; i < extValues.length; i += 1000) {
                        const chunk = extValues.slice(i, i + 1000);
                        const q = `SELECT Id, ${ext} FROM ${parentObject} WHERE ${ext} IN (${chunk.map((v: any) => typeof v === 'string' ? `'${String(v).replace(/'/g, "\\'")}'` : v).join(', ')})`;
                        try {
                            const targetResp = await this.targetConn.query(q);
                            if (targetResp?.records?.length) {
                                for (const r of targetResp.records) {
                                    existingByExternal[r[ext]] = r.Id;
                                }
                            }
                        } catch (e) {
                            result.errors.push(`Lookup of existing ${parentObject} by external id failed: ${this.stringifyErrors(e)}`);
                        }
                    }
                }
            }

            // Prepare create payloads for parents possibly missing in target
            const createPayload = fetchedParents.map((p: any) => {
                const out: any = {};
                if (nameField && p.Name) { out.Name = p.Name; }
                for (const ext of externalIdFields) {
                    if (p[ext] !== undefined) { out[ext] = p[ext]; }
                }
                return out;
            });

            // Create parents (idempotent if external ids exist)
            try {
                if (createPayload.length > 0) {
                    await this.targetConn.create(parentObject, createPayload);
                }
            } catch (e) {
                result.errors.push(`Parent ensure failed for ${parentObject}: ${this.stringifyErrors(e)}`);
            }

            // Build source->target id mapping
            for (const p of fetchedParents) {
                let tgtId: string | undefined;
                if (externalIdFields.length > 0) {
                    const ext = externalIdFields[0];
                    const val = p[ext];
                    if (val !== undefined) {
                        // Try cache first
                        if (existingByExternal[val]) {
                            tgtId = existingByExternal[val];
                        } else {
                            // Query target by external id
                            try {
                                const q = `SELECT Id FROM ${parentObject} WHERE ${ext} = ${typeof val === 'string' ? `'${String(val).replace(/'/g, "\\'")}'` : val} LIMIT 1`;
                                const tr = await this.targetConn.query(q);
                                if (tr?.records?.length) {
                                    tgtId = tr.records[0].Id;
                                }
                            } catch { /* ignore */ }
                        }
                        return sourceToTargetId;
                    }
                }

                // Fallback by Name
                if (!tgtId && nameField && p.Name) {
                    try {
                        const q = `SELECT Id FROM ${parentObject} WHERE Name = '${String(p.Name).replace(/'/g, "\\'")}' LIMIT 1`;
                        const tr = await this.targetConn.query(q);
                        if (tr?.records?.length) {
                            tgtId = tr.records[0].Id;
                        }
                    } catch { /* ignore */ }
                }

                if (tgtId) {
                    sourceToTargetId[p.Id] = tgtId;
                }
            }
        }

        return sourceToTargetId;
    }

    /**
     * New approach: Handle relationships based on transfer mode and user configuration
     */
    private async ensureParentRecordsExistNew(objectType: string, metadata: any, batch: any[], result: TransferResult, options: DataTransferOptions): Promise<Record<string, string>> {
        if (!this.sourceConn || !this.targetConn) { return {}; }

        const referenceFields = metadata.fields.filter((f: any) => f.type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo.length > 0);
        if (referenceFields.length === 0) { return {}; }

        const sourceToTargetId: Record<string, string> = {};
        const parentIdsByObject: Record<string, Set<string>> = {};

        // Collect all parent IDs from reference fields
        for (const rec of batch) {
            for (const ref of referenceFields) {
                const parentId = rec[ref.name];
                const parentObject = ref.referenceTo[0];
                if (parentId && typeof parentId === 'string' && parentObject) {
                    parentIdsByObject[parentObject] = parentIdsByObject[parentObject] || new Set<string>();
                    parentIdsByObject[parentObject].add(parentId);
                }
            }
        }

        // Process each parent object type
        for (const [parentObject, idSet] of Object.entries(parentIdsByObject)) {
            const ids = Array.from(idSet);
            if (ids.length === 0) { continue; }

            if (options.transferMode === 'insert') {
                // INSERT MODE: Create parents first, map source IDs to new target IDs
                await this.handleInsertModeParents(parentObject, ids, sourceToTargetId, result);
            } else if (options.transferMode === 'upsert') {
                // UPSERT MODE: Use user-specified external ID for matching
                await this.handleUpsertModeParents(parentObject, ids, sourceToTargetId, result, options);
            }
        }

        return sourceToTargetId;
    }

    /**
     * Insert mode: Create parent records first, then use the new IDs for children
     */
    private async handleInsertModeParents(parentObject: string, parentIds: string[], idMapping: Record<string, string>, result: TransferResult): Promise<void> {
        if (!this.sourceConn || !this.targetConn) { return; }

        try {
            // Fetch parent records from source with all necessary fields
            const parentDescribe = await this.sourceConn.describe(parentObject);
            const insertableFields = parentDescribe.fields
                .filter((f: any) => f.createable && !f.autoNumber && f.name !== 'Id' && this.isInsertableField(f))
                .map((f: any) => f.name);

            if (insertableFields.length === 0) { return; }

            // Fetch parents in batches
            const chunkSize = 1000;
            const parentRecords: any[] = [];
            
            for (let i = 0; i < parentIds.length; i += chunkSize) {
                const chunk = parentIds.slice(i, i + chunkSize);
                const soql = `SELECT Id, ${insertableFields.join(', ')} FROM ${parentObject} WHERE Id IN (${chunk.map(id => `'${id}'`).join(', ')})`;
                const resp = await this.sourceConn.query(soql);
                if (resp?.records?.length) {
                    parentRecords.push(...resp.records);
                }
            }

            if (parentRecords.length === 0) { return; }

            // Clean and prepare records for insert
            const cleanParents = parentRecords.map(record => {
                const clean: any = { ...record };
                // Remove system fields
                this.removeSystemFields(clean);
                // Remove any lookup fields to avoid circular dependencies
                Object.keys(clean).forEach(key => {
                    const field = parentDescribe.fields.find((f: any) => f.name === key);
                    if (field && field.type === 'reference') {
                        delete clean[key]; // Remove lookup fields
                    }
                });
                return clean;
            });

            // Insert parent records and map IDs
            const insertResult = await this.targetConn.create(parentObject, cleanParents);
            
            if (insertResult && Array.isArray(insertResult)) {
                for (let i = 0; i < insertResult.length; i++) {
                    const insertedRecord = insertResult[i];
                    const originalRecord = parentRecords[i];
                    
                    if (insertedRecord.success && insertedRecord.id) {
                        idMapping[originalRecord.Id] = insertedRecord.id;
                    } else {
                        result.errors.push(`Failed to insert parent ${parentObject}: ${this.stringifyErrors(insertedRecord.errors)}`);
                    }
                }
            }
        } catch (error) {
            result.errors.push(`Error handling insert mode parents for ${parentObject}: ${this.stringifyErrors(error)}`);
        }
    }

    /**
     * Upsert mode: Use user-specified external ID fields for parent matching
     */
    private async handleUpsertModeParents(parentObject: string, parentIds: string[], idMapping: Record<string, string>, result: TransferResult, options: DataTransferOptions): Promise<void> {
        if (!this.sourceConn || !this.targetConn || !options.externalIdMapping) { return; }

        const externalIdField = options.externalIdMapping[parentObject];
        if (!externalIdField) {
            result.errors.push(`No external ID field specified for ${parentObject}. Please configure external ID mapping for upsert mode.`);
            return;
        }

        try {
            // Fetch parent records with external ID field
            const chunkSize = 1000;
            const parentRecords: any[] = [];
            
            for (let i = 0; i < parentIds.length; i += chunkSize) {
                const chunk = parentIds.slice(i, i + chunkSize);
                const soql = `SELECT Id, ${externalIdField} FROM ${parentObject} WHERE Id IN (${chunk.map(id => `'${id}'`).join(', ')})`;
                const resp = await this.sourceConn.query(soql);
                if (resp?.records?.length) {
                    parentRecords.push(...resp.records);
                }
            }

            // Query target org to find existing records by external ID
            for (const parentRecord of parentRecords) {
                const externalIdValue = parentRecord[externalIdField];
                if (!externalIdValue) { continue; }

                try {
                    const targetQuery = `SELECT Id FROM ${parentObject} WHERE ${externalIdField} = '${String(externalIdValue).replace(/'/g, "\\'")}'`;
                    const targetResult = await this.targetConn.query(targetQuery);
                    
                    if (targetResult?.records?.length > 0) {
                        // Found existing record - map source ID to target ID
                        idMapping[parentRecord.Id] = targetResult.records[0].Id;
                    } else {
                        // No existing record found - user needs to handle this case
                        result.errors.push(`Parent record ${parentObject} with ${externalIdField} = '${externalIdValue}' not found in target org. Consider running parent transfer first.`);
                    }
                } catch (error) {
                    result.errors.push(`Error looking up parent ${parentObject} by ${externalIdField}: ${this.stringifyErrors(error)}`);
                }
            }
        } catch (error) {
            result.errors.push(`Error handling upsert mode parents for ${parentObject}: ${this.stringifyErrors(error)}`);
        }
    }
}