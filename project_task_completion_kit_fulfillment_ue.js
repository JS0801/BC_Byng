/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Project Task afterSubmit -> Kit Line Fulfillment
 *
 * This runs the same project + kit unit of work as the map-only script, but
 * only after confirming that the project + kit combo appears in the grouped
 * eligibility saved search.
 */
define(['N/record', 'N/runtime', 'N/search'],
    (record, runtime, search) => {

        const MATERIAL_CONSUMPTION_LOG_MAX_LENGTH = 3900;

        const STAMP_FIELD_IDS = {
            custevent_bc_materials_consumed: true,
            custevent_bc_job_complete_processed: true,
            custevent_bc_material_consumption_log: true
        };

        /* ------------------------------------------------------------------ */
        const afterSubmit = (context) => {
            let taskIds = [];
            let projectRecordId = '';
            let kitItemId = '';

            try {
                if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) {
                    return;
                }

                if (isStampOnlyXedit(context)) {
                    log.debug('skip - stamp-only xedit', context.newRecord.id);
                    return;
                }

                const projectTaskRecord = record.load({
                    type: 'projecttask',
                    id: context.newRecord.id,
                    isDynamic: false
                });

                projectRecordId = safeGetValue(projectTaskRecord, 'company') || safeGetValue(projectTaskRecord, 'project');
                kitItemId = safeGetValue(projectTaskRecord, 'custevent_bc_fsm_pt_kit_no');

                if (!projectRecordId || !kitItemId) {
                    log.debug('skip - missing project or kit', {
                        taskId: context.newRecord.id,
                        projectRecordId: projectRecordId,
                        kitItemId: kitItemId
                    });
                    return;
                }

                if (safeGetValue(projectTaskRecord, 'custevent_bc_materials_consumed')) {
                    log.debug('skip - task already consumed', {
                        taskId: context.newRecord.id,
                        projectRecordId: projectRecordId,
                        kitItemId: kitItemId
                    });
                    return;
                }

                const eligibilitySearch = getEligibilitySearch();

                if (!isProjectKitEligible(eligibilitySearch, projectRecordId, kitItemId)) {
                    log.debug('skip - project/kit not eligible yet', {
                        taskId: context.newRecord.id,
                        projectRecordId: projectRecordId,
                        kitItemId: kitItemId
                    });
                  //  return;
                }

                taskIds = getProjectKitTaskIds(projectRecordId, kitItemId);
                log.audit('eligible project/kit tasks', {
                    projectRecordId: projectRecordId,
                    kitItemId: kitItemId,
                    taskIds: taskIds
                });

                if (!taskIds.length) {
                    return;
                }

                const salesOrders = getSalesOrders(projectRecordId, kitItemId);
                log.audit('sales orders for project/kit', {
                    projectRecordId: projectRecordId,
                    kitItemId: kitItemId,
                    salesOrders: salesOrders
                });

                if (!salesOrders.length) {
                    const msg = [
                        'Not fulfilled.',
                        'Project: ' + projectRecordId,
                        'Kit: ' + kitItemId,
                        'Reason: no Sales Order line found for this project and kit.',
                        'Will retry next run.'
                    ].join('\n');
                    stampTasks(taskIds, { custevent_bc_material_consumption_log: msg });
                    return;
                }

                const results = salesOrders.map((salesOrder) => {
                    return fulfillKitOnSalesOrder(salesOrder, kitItemId);
                });

                log.debug('results', results);

                const failedResults = results.filter((r) => !r.success);
                const completeResults = results.filter((r) => r.success);

                if (failedResults.length) {
                    const msg = buildFailureMessage(projectRecordId, kitItemId, completeResults, failedResults);
                    log.audit('project/kit not fully fulfilled', msg);
                    stampTasks(taskIds, { custevent_bc_material_consumption_log: msg });
                    return;
                }

                const msg = buildSuccessMessage(projectRecordId, kitItemId, completeResults);
                log.audit('project/kit fulfilled', msg);

                stampTasks(taskIds, {
                    custevent_bc_materials_consumed: true,
                    custevent_bc_job_complete_processed: new Date(),
                    custevent_bc_material_consumption_log: msg
                });
            } catch (e) {
                const msg = [
                    'Unexpected error.',
                    'Project: ' + projectRecordId,
                    'Kit: ' + kitItemId,
                    'Reason: ' + scrub(e),
                    'Will retry next run.'
                ].join('\n');
                log.error('afterSubmit error', msg);

                if (taskIds.length) {
                    stampTasks(taskIds, { custevent_bc_material_consumption_log: msg });
                }
            }
        };

        /* ------------------------------------------------------------------ */
        function isStampOnlyXedit(context) {
            if (context.type !== context.UserEventType.XEDIT) {
                return false;
            }

            const fields = context.newRecord.getFields() || [];
            if (!fields.length) {
                return false;
            }

            return fields.every((fieldId) => {
                return STAMP_FIELD_IDS[fieldId] || fieldId === 'id' || fieldId === 'internalid';
            });
        }

        /* ------------------------------------------------------------------ */
        function safeGetValue(rec, fieldId) {
            try {
                return rec.getValue({ fieldId: fieldId });
            } catch (e) {
                return '';
            }
        }

        /* ------------------------------------------------------------------ */
        function getEligibilitySearch() {
            const searchId = runtime.getCurrentScript().getParameter({
                name: 'custscript_bc_ptc_savedsearc'
            });

            if (!searchId) {
                throw new Error('Missing script parameter custscript_bc_ptc_savedsearc.');
            }

            return search.load({ id: searchId });
        }

        /* ------------------------------------------------------------------ */
        function isProjectKitEligible(eligibilitySearch, projectRecordId, kitItemId) {
            const filters = eligibilitySearch.filters || [];

            filters.push(search.createFilter({
                name: 'company',
                operator: search.Operator.ANYOF,
                values: projectRecordId
            }));
            filters.push(search.createFilter({
                name: 'custevent_bc_fsm_pt_kit_no',
                operator: search.Operator.IS,
                values: kitItemId
            }));

            eligibilitySearch.filters = filters;

            return eligibilitySearch.run().getRange({
                start: 0,
                end: 1
            }).length > 0;
        }

        /* ------------------------------------------------------------------ */
        function getSearchValue(valueObj) {
            if (valueObj && typeof valueObj === 'object') {
                return valueObj.value;
            }
            return valueObj;
        }

        /* ------------------------------------------------------------------ */
        function getProjectKitTaskIds(projectRecordId, kitItemId) {
            const taskIds = [];

            search.create({
                type: 'projecttask',
                filters: [
                    ['company', 'anyof', projectRecordId],
                    'AND',
                    ['custevent_bc_fsm_pt_kit_no', 'is', kitItemId],
                    'AND',
                    ['custevent_bc_materials_consumed', 'is', 'F']
                ],
                columns: [search.createColumn({ name: 'internalid' })]
            }).run().each((r) => {
                taskIds.push(r.getValue({ name: 'internalid' }));
                return true;
            });

            return taskIds;
        }

        /* ------------------------------------------------------------------ */
        function getSalesOrders(projectRecordId, kitItemId) {
            const salesOrders = [];
            const seen = {};

            search.create({
                type: 'salesorder',
                settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
                filters: [
                    ['type', 'anyof', 'SalesOrd'],
                    'AND',
                    ['mainline', 'is', 'F'],
                    'AND',
                    ['jobmain.internalid', 'anyof', projectRecordId],
                    'AND',
                    ['item', 'anyof', kitItemId]
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'tranid' }),
                    search.createColumn({ name: 'quantity' }),
                    search.createColumn({ name: 'quantitypicked' }),
                    search.createColumn({ name: 'custcol_bc_trade_location' })
                ]
            }).run().each((result) => {
                const salesOrderId = result.getValue({ name: 'internalid' });
                if (!salesOrderId) {
                    return true;
                }

                if (!seen[salesOrderId]) {
                    seen[salesOrderId] = {
                        id: salesOrderId,
                        tranid: result.getValue({ name: 'tranid' }),
                        quantity: 0,
                        quantityFulfilled: 0
                    };
                    salesOrders.push(seen[salesOrderId]);
                }

                seen[salesOrderId].quantity += Math.abs(toNumber(result.getValue({ name: 'quantity' })));
                seen[salesOrderId].quantityFulfilled += Math.abs(toNumber(result.getValue({ name: 'quantitypicked' })));
                const tradeLocation = result.getValue({ name: 'custcol_bc_trade_location' });
                if (tradeLocation && !seen[salesOrderId].location) {
                    seen[salesOrderId].location = tradeLocation;
                }
                return true;
            });

            return salesOrders;
        }

        /* ------------------------------------------------------------------ */
        function fulfillKitOnSalesOrder(salesOrder, kitItemId) {
            const salesOrderRecordId = salesOrder.id;
            const salesOrderTranId = salesOrder.tranid;

            try {
                const existingFulfillments = getExistingItemFulfillments(salesOrderRecordId, kitItemId);
                log.debug('existingFulfillments', existingFulfillments);

                if (existingFulfillments.length) {
                    return {
                        success: true,
                        alreadyFulfilled: true,
                        salesOrderId: salesOrderRecordId,
                        salesOrderTranId: salesOrderTranId,
                        message: getAlreadyFulfilledMessage(existingFulfillments)
                    };
                }

                if (isSalesOrderKitAlreadyFulfilled(salesOrder)) {
                    return {
                        success: true,
                        alreadyFulfilled: true,
                        salesOrderId: salesOrderRecordId,
                        salesOrderTranId: salesOrderTranId,
                        message: getAlreadyFulfilledMessage(existingFulfillments)
                    };
                }

                const itemFulfillmentRecord = record.transform({
                    fromType: 'salesorder',
                    fromId: salesOrderRecordId,
                    toType: 'itemfulfillment'
                });

                const itemSublistLineCount = itemFulfillmentRecord.getLineCount({ sublistId: 'item' });
                let matchedLineCount = 0;
                let receivableLineCount = 0;
                let alreadyFulfilledLineCount = 0;

                for (let ctr = 0; ctr < itemSublistLineCount; ctr++) {
                    const itemRecordId = itemFulfillmentRecord.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: ctr
                    });

                    if (String(itemRecordId) !== String(kitItemId)) {
                        itemFulfillmentRecord.setSublistValue({
                            sublistId: 'item',
                            fieldId: 'itemreceive',
                            line: ctr,
                            value: false,
                            fireSlavingSync: true
                        });
                        continue;
                    }

                    matchedLineCount++;

                    const itemQuantityRemaining = toNumber(itemFulfillmentRecord.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantityremaining',
                        line: ctr
                    }));
                    const itemQuantityCommitted = toNumber(itemFulfillmentRecord.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantitycommitted',
                        line: ctr
                    }));
                    const itemLocation = itemFulfillmentRecord.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'location',
                        line: ctr
                    });

                    if (itemQuantityRemaining <= 0) {
                        alreadyFulfilledLineCount++;
                        itemFulfillmentRecord.setSublistValue({
                            sublistId: 'item',
                            fieldId: 'itemreceive',
                            line: ctr,
                            value: false,
                            fireSlavingSync: true
                        });
                        continue;
                    }

                    if (itemQuantityCommitted < itemQuantityRemaining) {
                        itemFulfillmentRecord.setSublistValue({
                            sublistId: 'item',
                            fieldId: 'itemreceive',
                            line: ctr,
                            value: false,
                            fireSlavingSync: true
                        });
                        continue;
                    }

                    receivableLineCount++;

                    const fulfillmentLocation = salesOrder.location || itemLocation;

                    if (salesOrder.location) {
                        itemFulfillmentRecord.setSublistValue({
                            sublistId: 'item',
                            fieldId: 'location',
                            line: ctr,
                            value: salesOrder.location,
                            fireSlavingSync: true
                        });
                    }

                    itemFulfillmentRecord.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemreceive',
                        line: ctr,
                        value: true,
                        fireSlavingSync: true
                    });
                    itemFulfillmentRecord.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: ctr,
                        value: itemQuantityRemaining,
                        fireSlavingSync: true
                    });

                    assignInventoryDetailIfNeeded(itemFulfillmentRecord, ctr, itemRecordId, fulfillmentLocation, itemQuantityRemaining);
                    assignKitMemberLines(itemFulfillmentRecord, ctr, itemSublistLineCount, fulfillmentLocation);
                }

                if (!matchedLineCount) {
                    return {
                        success: false,
                        salesOrderId: salesOrderRecordId,
                        salesOrderTranId: salesOrderTranId,
                        message: 'No matching kit line found.'
                    };
                }

                if (alreadyFulfilledLineCount === matchedLineCount) {
                    return {
                        success: true,
                        alreadyFulfilled: true,
                        salesOrderId: salesOrderRecordId,
                        salesOrderTranId: salesOrderTranId,
                        message: 'Kit already fulfilled. No new Item Fulfillment created.'
                    };
                }

                if (!receivableLineCount) {
                    return {
                        success: false,
                        salesOrderId: salesOrderRecordId,
                        salesOrderTranId: salesOrderTranId,
                        message: 'Matching kit line is uncommitted or not receivable.'
                    };
                }

                let itemFulfillmentRecordId;
                try {
                    itemFulfillmentRecordId = itemFulfillmentRecord.save();
                } catch (saveErr) {
                    if (isNoValidLineItemError(saveErr)) {
                        const fulfillmentsAfterSaveAttempt = getExistingItemFulfillments(salesOrderRecordId, kitItemId);

                        return {
                            success: true,
                            alreadyFulfilled: true,
                            salesOrderId: salesOrderRecordId,
                            salesOrderTranId: salesOrderTranId,
                            message: getAlreadyFulfilledMessage(fulfillmentsAfterSaveAttempt)
                        };
                    }

                    throw saveErr;
                }

                log.audit('IF created', {
                    so: getSalesOrderLabel({
                        salesOrderId: salesOrderRecordId,
                        salesOrderTranId: salesOrderTranId
                    }),
                    kit: kitItemId,
                    if: itemFulfillmentRecordId
                });

                return {
                    success: true,
                    salesOrderId: salesOrderRecordId,
                    salesOrderTranId: salesOrderTranId,
                    itemFulfillmentId: itemFulfillmentRecordId,
                    message: 'Item Fulfillment ' + itemFulfillmentRecordId + ' created.'
                };
            } catch (e) {
                return {
                    success: false,
                    salesOrderId: salesOrderRecordId,
                    salesOrderTranId: salesOrderTranId,
                    message: scrub(e)
                };
            }
        }

        /* ------------------------------------------------------------------ */
        function getAvailableQuantity(itemId, locationId) {
            if (!itemId || !locationId) {
                return 0;
            }

            let available = 0;

            search.create({
                type: search.Type.INVENTORY_BALANCE,
                filters: [
                    ['item.internalid', 'is', itemId],
                    'AND', ['location', 'anyof', locationId],
                    'AND', ['available', 'greaterthan', '0']
                ],
                columns: [
                    search.createColumn({ name: 'available', summary: 'SUM' })
                ]
            }).run().each((result) => {
                available += toNumber(result.getValue({ name: 'available', summary: 'SUM' }));
                return true;
            });

            return available;
        }

        /* ------------------------------------------------------------------ */
        function assignKitMemberLines(itemFulfillmentRecord, kitLine, itemSublistLineCount, fulfillmentLocation) {
            let kitMemberLine = kitLine + 1;

            while (kitMemberLine < itemSublistLineCount) {
                const kitMemberQuantityFactor = toNumber(itemFulfillmentRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'kitmemberquantityfactor',
                    line: kitMemberLine
                }));

                if (kitMemberQuantityFactor <= 0) {
                    break;
                }

                const memberItemId = itemFulfillmentRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: kitMemberLine
                });
                const memberQuantityRemaining = toNumber(itemFulfillmentRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantityremaining',
                    line: kitMemberLine
                }));

                // set location BEFORE quantity / inventory detail
                if (fulfillmentLocation) {
                    itemFulfillmentRecord.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'location',
                        line: kitMemberLine,
                        value: fulfillmentLocation,
                        fireSlavingSync: true
                    });
                }

                const memberLocation = itemFulfillmentRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'location',
                    line: kitMemberLine
                }) || fulfillmentLocation;

                // availability check at the resolved location
                const memberAvailable = getAvailableQuantity(memberItemId, memberLocation);
                if (memberAvailable < memberQuantityRemaining) {
                    throw new Error('Insufficient availability for member item ' + memberItemId +
                        ' at location ' + memberLocation + '. Need ' + memberQuantityRemaining +
                        ', available ' + memberAvailable + '.');
                }

                itemFulfillmentRecord.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: kitMemberLine,
                    value: memberQuantityRemaining,
                    fireSlavingSync: true
                });

                assignInventoryDetailIfNeeded(
                    itemFulfillmentRecord,
                    kitMemberLine,
                    memberItemId,
                    memberLocation,
                    memberQuantityRemaining
                );

                kitMemberLine++;
            }
        }

        /* ------------------------------------------------------------------ */
        function assignInventoryDetailIfNeeded(itemFulfillmentRecord, line, itemRecordId, itemLocation, quantityNeeded) {
            const itemLookUp = search.lookupFields({
                type: search.Type.ITEM,
                id: itemRecordId,
                columns: ['islotitem', 'usebins']
            });

            if (!itemLookUp.usebins) {
                return;
            }

            const inventoryDetailSubrecord = itemFulfillmentRecord.getSublistSubrecord({
                sublistId: 'item',
                fieldId: 'inventorydetail',
                line: line
            });

            clearInventoryAssignments(inventoryDetailSubrecord);

            let quantityToFulfill = toNumber(quantityNeeded);
            let iaCtr = 0;
            const inventoryDataArray = getInventoryData(itemRecordId, itemLocation);

            log.debug('inventoryDataArray', {
                item: itemRecordId,
                location: itemLocation,
                data: inventoryDataArray
            });

            inventoryDataArray.forEach((inventoryDataObj) => {
                if (quantityToFulfill <= 0) {
                    return true;
                }

                const binNumber = inventoryDataObj.bin;
                const binQuantity = toNumber(inventoryDataObj.qty);
                const assignmentQuantity = Math.min(binQuantity, quantityToFulfill);

                if (assignmentQuantity <= 0) {
                    return true;
                }

                inventoryDetailSubrecord.insertLine({
                    sublistId: 'inventoryassignment',
                    line: iaCtr
                });
                inventoryDetailSubrecord.setSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'binnumber',
                    line: iaCtr,
                    value: binNumber
                });
                inventoryDetailSubrecord.setSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'quantity',
                    line: iaCtr,
                    value: assignmentQuantity
                });

                quantityToFulfill -= assignmentQuantity;
                iaCtr++;
                return true;
            });

            if (quantityToFulfill > 0) {
                throw new Error('Insufficient available bin quantity for item ' + itemRecordId +
                    ' at location ' + itemLocation + '. Short by ' + quantityToFulfill + '.');
            }
        }

        /* ------------------------------------------------------------------ */
        function clearInventoryAssignments(inventoryDetailSubrecord) {
            const invAssignmentSublistLineCount = inventoryDetailSubrecord.getLineCount({
                sublistId: 'inventoryassignment'
            });

            for (let iaCtr = Number(invAssignmentSublistLineCount) - 1; iaCtr >= 0; iaCtr--) {
                inventoryDetailSubrecord.removeLine({
                    sublistId: 'inventoryassignment',
                    line: iaCtr
                });
            }
        }

        /* ------------------------------------------------------------------ */
        function isSalesOrderKitAlreadyFulfilled(salesOrder) {
            return toNumber(salesOrder.quantity) > 0 &&
                toNumber(salesOrder.quantityFulfilled) >= toNumber(salesOrder.quantity);
        }

        /* ------------------------------------------------------------------ */
        function getExistingItemFulfillments(salesOrderRecordId, kitItemId) {
            const fulfillments = [];
            const seen = {};
            log.debug('salesOrderRecordId', salesOrderRecordId);
            log.debug('kitItemId', kitItemId);

            search.create({
                type: 'itemfulfillment',
                filters: [
                    ['createdfrom', 'anyof', salesOrderRecordId],
                    'AND',
                    ['mainline', 'is', 'F'],
                    'AND',
                    ['item', 'anyof', kitItemId]
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'tranid' })
                ]
            }).run().each((result) => {
                const fulfillmentId = result.getValue({ name: 'internalid' });

                if (fulfillmentId && !seen[fulfillmentId]) {
                    seen[fulfillmentId] = true;
                    fulfillments.push({
                        id: fulfillmentId,
                        tranid: result.getValue({ name: 'tranid' })
                    });
                }

                return true;
            });

            log.debug('fulfillments', fulfillments);

            return fulfillments;
        }

        /* ------------------------------------------------------------------ */
        function getAlreadyFulfilledMessage(existingFulfillments) {
            if (existingFulfillments && existingFulfillments.length) {
                return 'Item Fulfillment already created for this kit item: ' + existingFulfillments.map((fulfillment) => {
                    if (fulfillment.tranid) {
                        return fulfillment.tranid + ' (internal id ' + fulfillment.id + ')';
                    }
                    return 'Item Fulfillment internal id ' + fulfillment.id;
                }).join(', ') + '. No new Item Fulfillment created.';
            }

            return 'Kit already fulfilled or has no valid remaining fulfillable line. No new Item Fulfillment created.';
        }

        /* ------------------------------------------------------------------ */
        function isNoValidLineItemError(e) {
            const text = scrub(e);
            return text.indexOf('VALID_LINE_ITEM_REQD') !== -1 ||
                text.indexOf('at least one valid line item') !== -1;
        }

        /* ------------------------------------------------------------------ */
        function getSalesOrderLabel(result) {
            if (result.salesOrderTranId) {
                return result.salesOrderTranId + ' (internal id ' + result.salesOrderId + ')';
            }
            return 'internal id ' + result.salesOrderId;
        }

        /* ------------------------------------------------------------------ */
        function formatResultLine(result) {
            return 'SO ' + getSalesOrderLabel(result) + ': ' + result.message;
        }

        /* ------------------------------------------------------------------ */
        function buildSuccessMessage(projectRecordId, kitItemId, completeResults) {
            const details = completeResults.map((r) => {
                return formatResultLine(r);
            }).join('\n');

            return [
                'Materials consumed.',
                'Project: ' + projectRecordId,
                'Kit: ' + kitItemId,
                details,
                'Processed on ' + (new Date()).toISOString() + '.'
            ].join('\n');
        }

        /* ------------------------------------------------------------------ */
        function buildFailureMessage(projectRecordId, kitItemId, completeResults, failedResults) {
            const successDetails = completeResults.map((r) => {
                return formatResultLine(r);
            }).join('\n');
            const failureDetails = failedResults.map((r) => {
                return formatResultLine(r);
            }).join('\n');

            const lines = [
                'Not fulfilled.',
                'Project: ' + projectRecordId,
                'Kit: ' + kitItemId
            ];

            if (successDetails) {
                lines.push('Successful attempts:');
                lines.push(successDetails);
            }

            lines.push('Failed attempts:');
            lines.push(failureDetails);
            lines.push('Will retry next run.');

            return lines.join('\n');
        }

        /* ------------------------------------------------------------------ */
        function stampTasks(taskIds, values) {
            taskIds.forEach((taskId) => {
                try {
                    record.submitFields({
                        type: 'projecttask',
                        id: taskId,
                        values: getStampValues(values)
                    });
                } catch (stampErr) {
                    log.error('failed to stamp task ' + taskId, stampErr);
                }
            });
        }

        /* ------------------------------------------------------------------ */
        function getStampValues(values) {
            const submitValues = {};

            Object.keys(values || {}).forEach((fieldId) => {
                if (fieldId === 'custevent_bc_material_consumption_log') {
                    submitValues[fieldId] = limitText(values[fieldId], MATERIAL_CONSUMPTION_LOG_MAX_LENGTH);
                } else {
                    submitValues[fieldId] = values[fieldId];
                }
            });

            return submitValues;
        }

        /* ------------------------------------------------------------------ */
        function limitText(value, maxLength) {
            if (value === null || value === undefined) {
                return value;
            }

            const text = String(value);
            const suffix = '\n...[truncated]';

            if (text.length <= maxLength) {
                return text;
            }

            return text.substring(0, maxLength - suffix.length) + suffix;
        }

        /* ------------------------------------------------------------------ */
        function scrub(e) {
            if (!e) {
                return 'Unknown error.';
            }
            const name = e.name ? (e.name + ': ') : '';
            return (name + (e.message || e.toString())).substring(0, 300);
        }

        /* ------------------------------------------------------------------ */
        function toNumber(value) {
            const n = Number(value || 0);
            return isNaN(n) ? 0 : n;
        }

        /* ------------------------------------------------------------------ */
        function getInventoryData(item, location) {
            const inventoryDataArray = [];

            const invSearchObj = search.create({
                type: search.Type.INVENTORY_BALANCE,
                filters: [
                    ['item.internalid', 'is', item],
                    'AND', ['location', 'anyof', location],
                    'AND', ['onhand', 'greaterthan', '0'],
                    'AND', ['available', 'greaterthan', '0']
                ],
                columns: [
                    search.createColumn({ name: 'item', summary: 'GROUP', label: 'Display Name' }),
                    search.createColumn({ name: 'binnumber', summary: 'GROUP', label: 'Bin Number' }),
                    search.createColumn({ name: 'inventorynumber', summary: 'GROUP', label: 'inventorynumber' }),
                    search.createColumn({ name: 'onhand', summary: 'SUM', label: 'On Hand' }),
                    search.createColumn({ name: 'available', summary: 'SUM', sort: search.Sort.DESC, label: 'Available' }),
                    search.createColumn({ name: 'status', summary: 'GROUP', label: 'status' }),
                    search.createColumn({ name: 'location', summary: 'GROUP', label: 'location' })
                ]
            });

            invSearchObj.run().each((result) => {
                const bin = result.getValue({ name: 'binnumber', summary: 'GROUP' });
                const lot = result.getValue({ name: 'inventorynumber', summary: 'GROUP' });
                const qty = toNumber(result.getValue({ name: 'available', summary: 'SUM' }));

                if (qty > 0) {
                    inventoryDataArray.push({
                        bin: bin,
                        lot: lot,
                        qty: qty
                    });
                }
                return true;
            });

            return inventoryDataArray;
        }

        return { afterSubmit };
    });