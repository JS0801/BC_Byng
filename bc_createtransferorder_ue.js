/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/runtime', 'N/search', 'N/ui/message', 'N/ui/serverWidget'],
    /**
 * @param{record} record
 * @param{runtime} runtime
 * @param{search} search
 * @param{message} message
 * @param{serverWidget} serverWidget
 */
    (record, runtime, search, message, serverWidget) => {
        /**
         * Defines the function definition that is executed before record is loaded.
         * @param {Object} scriptContext
         * @param {Record} scriptContext.newRecord - New record
         * @param {string} scriptContext.type - Trigger type; use values from the context.UserEventType enum
         * @param {Form} scriptContext.form - Current form
         * @param {ServletRequest} scriptContext.request - HTTP request information sent from the browser for a client action only.
         * @since 2015.2
         */
        const beforeLoad = (scriptContext) => {
            try{
                if(scriptContext.type == 'view'){
                    var currentRecordId = scriptContext.newRecord.getValue({fieldId: 'id'});

                    const salesorderSearchObj = search.create({
                        type: "salesorder",
                        settings:[{"name":"consolidationtype","value":"ACCTTYPE"}],
                        filters:
                        [
                            ["type","anyof","SalesOrd"], 
                            "AND", 
                            ["internalid","anyof",currentRecordId],
                            "AND", 
                            ["mainline","is","F"], 
                            "AND", 
                            ["cogs","is","F"], 
                            "AND", 
                            ["shipping","is","F"], 
                            "AND", 
                            ["taxline","is","F"], 
                            "AND", 
                            ["custcol_bc_trade_location","noneof","@NONE@"], 
                            "AND", 
                            ["custcol_bc_source_location","noneof","@NONE@"], 
                            "AND", 
                            ["custcol_bc_transferorder","anyof","@NONE@"], 
                            "AND", 
                            ["custcol_bc_projecttask","noneof","@NONE@"]
                        ],
                        columns:
                        [
                            search.createColumn({name: "item", label: "Item"})
                        ]
                    });

                    const searchResultCount = salesorderSearchObj.runPaged().count;
                    log.debug("salesorderSearchObj result count",searchResultCount);
                    
                    if(searchResultCount > 0){
                        var currentUser = runtime.getCurrentUser();                        
                        var currentUserId = currentUser.id;
                        log.debug('currentUserId', currentUserId);

                        var currentForm = scriptContext.form;

                        currentForm.addButton({
                            id: 'custpage_generatetransferorders',
                            label: 'Generate TOs',
                            functionName: 'generateTransferOrders(' + currentRecordId + ',' + currentUserId + ')'
                        });

                        scriptContext.form.clientScriptModulePath = './bc_createtransferorder_cs.js';
                    }                    
                }
            }
            catch (e){
                log.debug('beforeLoad error', e);
            }
        }

        /**
         * Defines the function definition that is executed before record is submitted.
         * @param {Object} scriptContext
         * @param {Record} scriptContext.newRecord - New record
         * @param {Record} scriptContext.oldRecord - Old record
         * @param {string} scriptContext.type - Trigger type; use values from the context.UserEventType enum
         * @since 2015.2
         */
        const beforeSubmit = (scriptContext) => {

        }

        /**
         * Defines the function definition that is executed after record is submitted.
         * @param {Object} scriptContext
         * @param {Record} scriptContext.newRecord - New record
         * @param {Record} scriptContext.oldRecord - Old record
         * @param {string} scriptContext.type - Trigger type; use values from the context.UserEventType enum
         * @since 2015.2
         */
        const afterSubmit = (scriptContext) => {

        }

        return {
            beforeLoad, 
            //beforeSubmit, 
            //afterSubmit
        }

    });
