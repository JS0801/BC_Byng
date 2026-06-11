/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/task'],
    /**
 * @param{task} task
 */
    (task) => {
        /**
         * Defines the Suitelet script trigger point.
         * @param {Object} scriptContext
         * @param {ServerRequest} scriptContext.request - Incoming request
         * @param {ServerResponse} scriptContext.response - Suitelet response
         * @since 2015.2
         */
        const onRequest = (scriptContext) => {
            try{
                var salesOrderRecordId = scriptContext.request.parameters.salesorder;    	
                log.debug('salesOrderRecordId', salesOrderRecordId);
            
                executeMapReduce(salesOrderRecordId);        
            }
            catch (e){
                log.debug('onRequest error', e);
            }
        }

        function executeMapReduce(salesOrderRecordId) {
            try{
                var scriptTask = task.create({
                    taskType: task.TaskType.MAP_REDUCE,
                    scriptId: "customscript_bc_createtransferorder_mr",
                    //deploymentId: "customdeploy_bc_createtransferorder_mr",
                    params: {
                        custscript_bc_cto_salesorder: salesOrderRecordId
                    }
                });
            
                var scriptTaskId = scriptTask.submit();
                log.debug("scriptTaskId", scriptTaskId);
            }
            catch (e){
                log.debug('executeMapReduce error', e);
            }		
    
        }

        return {onRequest}

    });
