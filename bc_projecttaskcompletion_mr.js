/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Project Task Completion -> Kit Line Fulfillment
 *
 * Map-only version:
 *   - one map row = one grouped project + kit combo
 *   - locate only the tasks for that project + kit
 *   - locate all matching Sales Orders for that project + kit
 *   - fulfill only that kit on each matching SO
 *   - stamp only this project + kit's tasks after the SO attempts finish
 */
define(['N/record', 'N/runtime', 'N/search'],
    (record, runtime, search) => {

        const MATERIAL_CONSUMPTION_LOG_MAX_LENGTH = 3900;

        /* ------------------------------------------------------------------ */
        const getInputData = (inputContext) => {
            try {
                const searchId = runtime.getCurrentScript().getParameter({ name: 'custscript_bc_ptc_savedsearch' });
                return search.load({ id: searchId });
            } catch (e) {
                log.error('getInputData error', e);
            }
        };

        /* ------------------------------------------------------------------ */
        const map = (mapContext) => {
            let taskIds = [];
            let projectRecordId = '';
            let kitItemId = '';

            try {
                const inputData = JSON.parse(mapContext.value);

                projectRecordId = getSearchValue(inputData.values['GROUP(company)']);
                kitItemId = getSearchValue(inputData.values['GROUP(custevent_bc_fsm_pt_kit_no)']);

                log.audit('map - project/kit input', {
                    projectRecordId: projectRecordId,
                    kitItemId: kitItemId
                });

                if (!projectRecordId || !kitItemId) {
                    throw new Error('Missing grouped project or kit value from input search.');
                }

                taskIds = getProjectKitTaskIds(projectRecordId, kitItemId);

                if (!taskIds.length) {
                    log.audit('map - skip, no tasks found', {
                        projectRecordId: projectRecordId,
                        kitItemId: kitItemId
                    });
                    return;
                }

                const salesOrders = getSalesOrders(projectRecordId, kitItemId);

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

                const failedResults = results.filter((r) => !r.success);
                const completeResults = results.filter((r) => r.success);

                if (failedResults.length) {
                    const msg = buildFailureMessage(projectRecordId, kitItemId, completeResults, failedResults);
                    log.audit('map - project/kit not fully fulfilled', msg);
                    stampTasks(taskIds, { custevent_bc_material_consumption_log: msg });
                    return;
                }

                const msg = buildSuccessMessage(projectRecordId, kitItemId, completeResults);
                log.audit('map - project/kit fulfilled', msg);

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
                log.error('map error', { message: msg, stack: e && e.stack });

                if (taskIds.length) {
                    stampTasks(taskIds, { custevent_bc_material_consumption_log: msg });
                }
            }
        };

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
                    // ['internalid', 'anyof', '9829'],
                    // "AND",
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

                itemFulfillmentRecord.setValue('shipstatus', 'C');

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
                    log.error('fulfillKitOnSalesOrder - save error', {
                        salesOrderId: salesOrderRecordId,
                        error: scrub(saveErr)
                    });
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
                log.error('fulfillKitOnSalesOrder - caught error', {
                    salesOrderId: salesOrderRecordId,
                    error: scrub(e)
                });
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

                if (binNumber)
                inventoryDetailSubrecord.setSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'binnumber',
                    line: iaCtr,
                    value: binNumber
                });

                inventoryDetailSubrecord.setSublistText({
                    sublistId: 'inventoryassignment',
                    fieldId: 'inventorystatus',
                    line: iaCtr,
                    text: 'Good / Available'
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
                    log.error('stampTasks - failed to stamp task ' + taskId, stampErr);
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
        const summarize = (summaryContext) => {
            try {
                if (summaryContext.inputSummary.error) {
                    log.error('summarize - input stage error', summaryContext.inputSummary.error);
                }

                summaryContext.mapSummary.errors.iterator().each((key, err) => {
                    log.error('summarize - map error key ' + key, err);
                    return true;
                });
            } catch (e) {
                log.error('summarize error', e);
            }
        };

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

        return { getInputData, map, summarize };
    });