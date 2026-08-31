"use strict";
import * as ocpp from './ocpp_constants.js'

//
//
// Utility functions
//
//
function formatDate(date) {
    var day = String(date.getDate()),
        monthIndex = String(date.getMonth() + 1),
        year = date.getFullYear(),
        h = date.getHours(),
        m = String(date.getMinutes()),
        s = String(date.getSeconds());

    if (day.length < 2) {
        day = ('0' + day.slice(-2));
    }
    if (monthIndex.length < 2) {
        monthIndex = ('0' + monthIndex.slice(-2));
    }
    if (h.length < 2) {
        h = ('0' + h.slice(-2));
    }
    if (m.length < 2) {
        m = ('0' + m.slice(-2));
    }
    if (s.length < 2) {
        s = ('0' + s.slice(-2));
    }
    return year + '-' + monthIndex + '-' + day + 'T' + h + ':' + m + ':' + s + 'Z';
}

function generateId() {
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    var id = "";
    for (var i = 0; i < 36; i++) {
        id += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return id;
}

function isEmpty(str) {
    return (!str || 0 === str.length);
}

//
// Store a key value in session storage
// @param key The key name
// @param value The key value
//
function setSessionKey(key,value) {
    sessionStorage.setItem(key,value)
}

//
// Get a key value from session storage
// @param key The key name
// @return The key value
//
function getSessionKey(key,default_value="") {
    var v = sessionStorage.getItem(key);
    if (!v) {
        v=default_value;
    }
    return v
}

//
// Store a key value in local storage
// @param key The key name
// @param value The key value
//
function setKey(key,value) {
    localStorage.setItem(key,value)
}

//
// Get a key value from local storage
// @param key The key name
// @return The key value
//
function getKey(key,default_value="") {
    var v = localStorage.getItem(key);
    if (!v) {
        v=default_value;
    }
    return v
}

//
//
// OCPPChargePoint class
//
//
export default class ChargePoint {
    
    //
    // Constructor
    // 
    // Initializes the charge point state, WebSocket connection, heartbeat timer,
    // and callback placeholders used by main.js.
    //
    constructor() {
        this._websocket            = null;
        this._heartbeat            = null;
        this._statusChangeCb       = null;
        this._availabilityChangeCb = null;
        this._loggingCb            = null;

        this._pendingRemoteStart = null;
    } 

    //
    // Set the StatusChange callback, this will be triggered when the internal status
    // of the charge point change
    // @param A callback function which takes two string arguments ("new status","optionnal detail")
    //
    setStatusChangeCallback(cb) {
        this._statusChangeCb = cb;
    }
    
    //
    // Set the logging callback, this will be triggered when the charge point want to output/log some information
    // @param A callback function which takes a string argument ("message to log")
    //
    setLoggingCallback(cb) {
        this._loggingCb = cb;
    }
    
    //
    // Set the availability callback, this will be triggered when the OCPP server triggers a SetAvailability message
    // @param A callback function which takes two arguments (int + string): (connectorId,"new availability")
    //
    setAvailabilityChangeCallback(cb) {
        this._availabilityChangeCb = cb;
    }
    
    //
    // output a log to the logging callback if any
    //
    logMsg(msg) {
        if (this._loggingCb) {
            msg = '[OCPP] '+msg;
            this._loggingCb(msg);
        }
    }

    //
    // Set the internal status of the CP and call the status update callback if any
    // @param s The new status value
    // @param msg Optional message (for information purpose)
    //
    setStatus(s,msg="") {
        setSessionKey(ocpp.KEY_CP_STATUS,s);
        if (this._statusChangeCb) {
            this._statusChangeCb(s,msg);
        }
    }
    
    //
    // Get reservations from local storage
    // @return The reservations list (as JSON object array), or an empty array if no reservation(s), or in case of error.
    //
    getReservations() {
        const raw = getKey(ocpp.KEY_RESERVATIONS, "[]");

        try {
            const parsed = JSON.parse(raw);

            if (!Array.isArray(parsed)) {
                console.warn("Stored reservation data was invalid; resetting");
                setKey(ocpp.KEY_RESERVATIONS, "[]");
                return [];
            }

            return parsed;
        } catch {
            console.warn("Could not read stored reservations; resetting");
            setKey(ocpp.KEY_RESERVATIONS, "[]");
            return [];
        }
    }

    //
    // Set reservations in local storage
    // @param reservations The reservations list (as JSON object array)
    //
    setReservations(reservations) {
        if (!Array.isArray(reservations)) {
            console.warn("Reservations must be an array");
            return;
        }

        setKey(ocpp.KEY_RESERVATIONS, JSON.stringify(reservations));
    }

    //
    // Check if a reservation is expired
    // @param reservation The reservation to check
    // @param nowMs The current timestamp in milliseconds
    // @return true if the reservation is expired, false otherwise
    //
    isReservationExpired(reservation, nowMs) {
        const expiry = reservation.expiryDate
            ? new Date(reservation.expiryDate)
            : null;

        return (
            !expiry || Number.isNaN(expiry.getTime()) || expiry.getTime() <= nowMs
        );
    }

    //
    // Release a reserved connector
    // @param connectorId The connector id to release
    //
    releaseReservedConnector(connectorId) {
        if (this.connectorStatus(connectorId) === ocpp.CONN_RESERVED) {
            this.setConnectorStatus(connectorId, ocpp.CONN_AVAILABLE, true);
        }
    }

    //
    // Purge expired reservations from local storage and free their connectors
    //
    purgeExpiredReservations() {
        const nowMs = Date.now();
        const activeReservations = [];
        const expiredConnectorIds = new Set();
        const reservations = this.getReservations();
        let hasExpiredReservations = false;

        // If there are no reservations, do nothing
        if (reservations.length === 0) {
            return;
        }

        // Iterate over all reservations and check if they are expired
        for (const reservation of reservations) {
            const connectorId = Number(reservation.connectorId);

            if (this.isReservationExpired(reservation, nowMs)) {
                hasExpiredReservations = true;

                // connectorId 0 represents a charge point-level reservation, which is not implemented yet.
                if (Number.isInteger(connectorId) && connectorId > 0) {
                    expiredConnectorIds.add(connectorId);
                } else {
                    console.warn(
                        `Found expired reservation with invalid or unsupported connectorId ${reservation.connectorId}, reservation id ${reservation.reservationId}. Reservation has been cleared, but connector status has not been updated.`
                    );
                }
            } else {
                activeReservations.push(reservation);
            }
        }

        // If nothing has expired, do nothing
        if (!hasExpiredReservations) {
            return;
        }

        // Remove expired reservations
        this.setReservations(activeReservations);

        // Release reserved connectors for valid, specific connector reservations
        for (const connectorId of expiredConnectorIds) {
            this.releaseReservedConnector(connectorId);
        }
    }

    //
    // Store or replace a reservation in local storage
    // @param reservation The reservation to store or replace (as JSON object)
    // @return status string
    //
    storeOrReplaceReservation(reservation) {
        // Purge expired reservations before storing the new one
        this.purgeExpiredReservations();

        const connectorId = Number(reservation.connectorId);

        // Connector 0 represents a charge point-level reservation in OCPP 1.6J.
        // This simulator currently supports only connector-level reservations.
        if (!Number.isInteger(connectorId) || connectorId < 1) {
            return ocpp.RESERVATION_STATUS_REJECTED;
        }

        const reservations = this.getReservations();

        // Check if a reservation already exists for the same reservationId
        const sameIdReservation = reservations.find(function (r) {
            return r.reservationId === reservation.reservationId;
        });

        // Create a new list of reservations without the same reservationId
        const reservationsWithoutSameId = reservations.filter(function (r) {
            return r.reservationId !== reservation.reservationId;
        });

        // Check if a reservation already exists for the same connector but different reservationId
        const connectorReservation = reservationsWithoutSameId.find(function (r) {
            return Number(r.connectorId) === connectorId;
        });

        // If a reservation already exists for the same connector but different reservationId, return OCCUPIED
        if (connectorReservation) {
            return ocpp.RESERVATION_STATUS_OCCUPIED;
        }

        // Store the new reservation in the list
        reservationsWithoutSameId.push(reservation);
        this.setReservations(reservationsWithoutSameId);

        // If a reservation already exists for the same id but on a different connector, release the old connector
        if (
            sameIdReservation &&
            Number(sameIdReservation.connectorId) !== connectorId
        ) {
            this.releaseReservedConnector(Number(sameIdReservation.connectorId));
        }

        // Set the connector as reserved, and update server with a StatusNotification
        this.setConnectorStatus(connectorId, ocpp.CONN_RESERVED, true);

        return ocpp.RESERVATION_STATUS_ACCEPTED;
    }

    //
    // Remove a reservation from local storage
    // @param reservationId The id of the reservation to remove
    // @return The removed reservation or null if not found
    //
    removeReservation(reservationId) {
        const reservations = this.getReservations();

        // Find the reservation to remove
        const removedReservation = reservations.find(function (r) {
            return r.reservationId === reservationId;
        });

        // If the reservation is not found, return null
        if (!removedReservation) {
            console.warn(`No reservation found with id ${reservationId}`);
            return null;
        }

        // Remove the reservation from local storage
        this.setReservations(
            reservations.filter(function (r) {
                return r.reservationId !== reservationId;
            })
        );

        // Return the removed reservation
        return removedReservation;
    }

    //
    // Cancel a reservation
    // @param reservationId The id of the reservation to cancel
    // @return true if the reservation was cancelled, false otherwise
    //
    cancelReservation(reservationId) {
        const removedReservation = this.removeReservation(reservationId);

        // If the reservation is not found, return false
        if (!removedReservation) {
            return false;
        }

        // Release the connector
        this.releaseReservedConnector(removedReservation.connectorId);

        return true;
    }

    //
    // Find a reservation matching a connectorId
    // @param connectorId The connector id to match
    // @return The matching reservation or null if not found
    //
    findReservationByConnectorId(connectorId) {
        // Purge expired reservations before searching for a match
        this.purgeExpiredReservations();

        const reservations = this.getReservations();

        // Find the reservation matching the connectorId
        return (
            reservations.find(function (r) {
                return Number(r.connectorId) === Number(connectorId);
            }) || null
        );
    }

    //
    // Check if a transaction can start on a connector according to active reservations
    // @param tagId The idTag requesting the transaction
    // @param connectorId The connector id to check
    // @return { accepted: boolean, reservation: object|null }
    //
    checkStartTransactionReservation(tagId, connectorId) {
        const reservation = this.findReservationByConnectorId(connectorId);

        if (!reservation) {
        return { accepted: true, reservation: null };
        }

        if (reservation.idTag !== tagId) {
        return { accepted: false, reservation };
        }

        return { accepted: true, reservation };
    }

    //
    // Handle a command coming from the OCPP server
    //
    handleCallRequest(id,request,payload) {
        var respOk = JSON.stringify([ocpp.CALLRESULT,id,{"status": "Accepted"}]);
        var connectorId=0;
        switch (request) {
            case "Reset":
                //Reset type can be SOFT, HARD
                var rstType=payload.type;
                this.logMsg("Reset Request: type="+rstType);
                this.wsSendData(respOk);
                this.wsDisconnect();
                break;

            case "RemoteStartTransaction":
                console.log("RemoteStartTransaction");

                const tagId = payload.idTag;
                const connectorId = payload.connectorId != null ? payload.connectorId : 1;

                this.logMsg("Reception of a RemoteStartTransaction request for tag "+tagId+" (connector "+connectorId+")");

                const { accepted, reservation } = this.checkStartTransactionReservation(
                    tagId,
                    connectorId,
                );

                if (!accepted) {
                    this.logMsg(
                        `RemoteStartTransaction rejected for tag ${tagId} on connector ${connectorId} due to existing reservation for another tag (reservation id ${reservation.reservationId})`,
                    );

                    const response = JSON.stringify([
                        ocpp.CALLRESULT,
                        id,
                        { status: "Rejected" },
                    ]);

                    this.wsSendData(response);
                    break;
                }

                const response = JSON.stringify([
                    ocpp.CALLRESULT,
                    id,
                    { status: "Accepted" },
                ]);

                this.wsSendData(response);
                // this.startTransaction(tagId, connectorId, reservation?.reservationId ?? 0);

                // Save the remote start information while Authorize is pending
                this._pendingRemoteStart = {
                    tagId: tagId,
                    connectorId: connectorId,
                    reservationId: reservation?.reservationId ?? 0
                };

                this.logMsg(
                    `RemoteStartTransaction accepted. Authorizing tag ${tagId}.`
                );

                // Send Authorize now that backend activation has occurred
                this.authorize(tagId);
                break;

            case "RemoteStopTransaction":
                var stop_id = payload.transactionId;
                this.logMsg("Reception of a RemoteStopTransaction request for transaction "+stop_id);
                this.wsSendData(respOk);
                this.stopTransactionWithId(stop_id);
                break;

            case "TriggerMessage":
                var requestedMessage = payload.requestedMessage;
                // connectorId is optionnal thus must check if it is provided
                if(payload["connectorId"]) { 
                    connectorId = payload["connectorId"];
                }
                this.logMsg("Reception of a TriggerMessage request ("+requestedMessage+")");
                this.wsSendData(respOk);
                this.triggerMessage(requestedMessage,connectorId);
                break;
                
            case "ChangeAvailability":
                var avail=payload.type;
                connectorId=payload.connectorId;
                this.logMsg("Reception of a ChangeAvailability request (connector "+connectorId+" "+avail+")");
                this.wsSendData(respOk);
                this.setConnectorAvailability(Number(connectorId),avail)
                break;
                
            case "UnlockConnector":
                this.wsSendData(respOk);
                // connector_locked = false;
                // $('.indicator').hide();
                //$('#yellow').show();
                //logMsg("Connector status changed to: "+connector_locked);
                break;

            case "ReserveNow": {
                // Handles OCPP 1.6J ReserveNow for connector-level reservations.
                // Current support: connectorId > 0, expiry cleanup, replacement by reservationId,
                // and Occupied when another active reservation already exists for the connector.
                // Not yet supported: connectorId 0 charge point-level reservations, parentIdTag
                // matching, Faulted/Unavailable status responses, and reservation config keys.
                const reservation = {
                    connectorId: payload.connectorId,
                    expiryDate: payload.expiryDate,
                    idTag: payload.idTag,
                    reservationId: payload.reservationId,
                    parentIdTag: payload.parentIdTag ?? null,
                };

                const status = this.storeOrReplaceReservation(reservation);

                const parentIdTagText =
                    reservation.parentIdTag != null
                        ? `, parentIdTag ${reservation.parentIdTag}`
                        : "";

                this.logMsg(
                    `Received reservation request (connector ${reservation.connectorId}, expiryDate ${reservation.expiryDate}, idTag ${reservation.idTag}, reservationId ${reservation.reservationId}${parentIdTagText})`
                );

                let response = JSON.stringify([
                    ocpp.CALLRESULT,
                    id,
                    { status: status },
                ]);

                this.wsSendData(response);
                break;
            }

            case "CancelReservation": {
                const reservationId = payload.reservationId;
                const cancelled = this.cancelReservation(reservationId);

                this.logMsg(
                    `Received cancel reservation request (reservationId ${reservationId})`
                );

                let response = JSON.stringify([
                    ocpp.CALLRESULT,
                    id,
                    {
                        status: cancelled
                            ? ocpp.RESERVATION_STATUS_ACCEPTED
                            : ocpp.RESERVATION_STATUS_REJECTED,
                    },
                ]);

                this.wsSendData(response);
                break;
            }

            default:
                var error = JSON.stringify([ocpp.CALLERROR,id,"NotImplemented"]);
                this.wsSendData(error);
                break;
        }
    }

    //
    // Handle the response from the OCPP server to a command 
    // @param payload The payload part of the OCPP message
    //
    handleCallResult(payload) {
        var la = this.getLastAction();
        if (la == "BootNotification") {
            if (payload.status == 'Accepted') {
                this.logMsg("Connection accepted");
                var hb_interval = payload.interval;
                this.setHeartbeat(hb_interval);
                this.setStatus(ocpp.CP_CONNECTED);
            }
            else {
                this.logMsg("Connection refused by server");
                this.wsDisconnect();
            }
        }
        else if (la == "Authorize") {
            if (payload.idTagInfo.status == 'Invalid') {
                this.logMsg('Authorization failed');
                this._pendingRemoteStart = null;
                return;
            }

            this.logMsg('Authorization OK');
            this.setStatus(ocpp.CP_AUTHORIZED);

            if (this._pendingRemoteStart) {
                const pending = this._pendingRemoteStart;
                this._pendingRemoteStart = null;

                setTimeout(() => {
                    this.startTransaction(
                        pending.tagId,
                        pending.connectorId,
                        pending.reservationId
                    );
                }, 5000);
            }
        }
        else if (la == "startTransaction") {
            var transactionId = payload.transactionId;
            setSessionKey('TransactionId',transactionId);
            this.setStatus(ocpp.CP_INTRANSACTION,'TransactionId: '+transactionId)
            this.logMsg("Transaction id is "+transactionId);
        }
    }

    //
    // Handle an error response from the OCPP server
    // @param errCode The error code
    // @param errMsg  The clear text description of the error
    //
    handleCallError(errCode,errMsg) {
        this.setStatus(ocpp.CP_ERROR,'ErrorCode: '+errCode+' ('+errMsg+')');
    }

    //
    // Send an Authorize call to the OCPP Server
    // @param tagId the id of the RFID tag to authorize
    //
    authorize(tagId){
        this.setLastAction("Authorize");
        this.logMsg("Requesting authorization for tag " + tagId);
        var id=generateId();
        var Auth = JSON.stringify([ocpp.CALL,id,"Authorize", {
            "idTag": tagId
        }]);
        this.wsSendData(Auth);
    }

    //
    // Send a StartTransaction call to the OCPP Server
    // @param tagId the id of the RFID tag currently authorized on the CP
    // @param
    // @param
    //
    startTransaction(tagId, connectorId=1, reservationId=0){
        // Reserved connectors only allow StartTransaction for the reservation's idTag.
        // parentIdTag matching is part of OCPP 1.6J but is not implemented yet.
        const { accepted, reservation } = this.checkStartTransactionReservation(
            tagId,
            connectorId
        );

        if (!accepted) {
            this.logMsg(
                `StartTransaction rejected for tag ${tagId} on connector ${connectorId} due to existing reservation for another tag (reservation id ${reservation.reservationId})`
            );
            return false;
        }

        if (reservation) {
            reservationId = reservation.reservationId;

            // Remove the reservation, but do not release the connector because it is going straight to Charging.
            this.removeReservation(reservationId);

            this.logMsg(
                `StartTransaction accepted for tag ${tagId} on connector ${connectorId} with matching reservation (reservation id ${reservationId})`
            );
        }

        this.setLastAction("startTransaction");
        this.setStatus(ocpp.CP_INTRANSACTION);
        var mv = this.meterValue();
        var id=generateId();
        var strtT = JSON.stringify([ocpp.CALL,id,"StartTransaction", {
            "connectorId": connectorId,
            "idTag": tagId,
            "timestamp": formatDate(new Date()),
            "meterStart": mv,
            "reservationId": reservationId
        }]);
        this.logMsg("Starting Transaction for tag "+tagId+" (connector:"+connectorId+", meter value="+mv+", reservationId="+reservationId+")");
        this.wsSendData(strtT);
        this.setConnectorStatus(connectorId,ocpp.CONN_CHARGING);
        return true;
    }

    //
    // Send a StopTransaction call to the OCPP Server
    // @param tagId the id of the RFID tag currently authorized on the CP
    //
    stopTransaction(tagId){
        var transactionId=getSessionKey("TransactionId");
        this.stopTransactionWithId(transactionId,tagId);
    }
    
    //
    // Send a StopTransaction call to the OCPP Server
    // @param transactionId the id of the transaction to stop
    // @param tagId the id of the RFID tag currently authorized on the CP
    //
    stopTransactionWithId(transactionId, tagId="DEADBEEF"){
        this.setLastAction("stopTransaction");
        this.setStatus(ocpp.CP_CONNECTED);
        var mv=this.meterValue();
        this.logMsg("Stopping Transaction with id "+transactionId+" (meterValue="+mv+")");
        var id=generateId();
        var stopParams = {           
            "transactionId": transactionId,
            "timestamp": formatDate(new Date()),
            "meterStop": mv};
        if (!isEmpty(tagId)) {
            stopParams["idTag"]=tagId;
        }
        var stpT = JSON.stringify([ocpp.CALL, id, "StopTransaction",stopParams]);
        this.wsSendData(stpT);
        this.setConnectorStatus(1,ocpp.CONN_AVAILABLE);
    }
    
    //
    // Implement the TriggerMessage request
    // @param requestedMessage the message that shall be triggered
    // @param c connectorId concerned by the message (if any)
    //
    triggerMessage(requestedMessage,c=0) {
        switch(requestedMessage) {
            case 'BootNotification':
                this.sendBootNotification();
                break;
            case 'Heartbeat':
                this.sendHeartbeat();
                break;
            case 'MeterValues':
                this.sendMeterValue(c);
                break;
            case 'StatusNotification':
                this.sendStatusNotification(c);
                break;
            case 'DiagnosticStatusNotification':
                break;
            case 'FirmwareStatusNotification':
                break;
            default:
                this.logMsg("Requested Message not supported: "+requestedMessage);
                break;
        }
    }
    
    //
    // Send a BootNotification call to the OCPP Server
    //
    sendBootNotification(){
        this.logMsg('Sending BootNotification');
        this.setLastAction("BootNotification");
        var id=generateId();
        var bn_req = JSON.stringify([ocpp.CALL, id, "BootNotification", {
            "chargePointVendor": "Elmo",
            "chargePointModel": "Elmo-Virtual1",
            "chargePointSerialNumber": "elm.001.13.1",
            "chargeBoxSerialNumber": "elm.001.13.1.01",
            "firmwareVersion": "0.9.87",
            "iccid": "",
            "imsi": "",
            "meterType": "ELM NQC-ACDC",
            "meterSerialNumber": "elm.001.13.1.01"
        }]);
        this.wsSendData(bn_req);
    }

    // @todo: Shitty code to remove asap => real transaction support
    setLastAction(action) {
        setSessionKey("LastAction",action);
    }
    // @todo: Shitty code to remove asap
    getLastAction(){
        return getSessionKey("LastAction");
    }
    
    //
    // Setup heartbeat sending at the appropriate period
    // (clearing any previous setup)
    // @param period The heartbeat period in seconds
    //
    setHeartbeat(period){
        this.logMsg("Setting heartbeat period to "+period+"s");
        if (this._heartbeat) {
            clearInterval(this._heartbeat);
        }
        this._heartbeat = setInterval(() => this.sendHeartbeat(), period * 1000);
    }

    //
    // Send a heartbeat to the OCPP Server
    //
    sendHeartbeat() {
        this.setLastAction("Heartbeat");
        var id=generateId();
        var HB = JSON.stringify([ocpp.CALL,id,"Heartbeat", {}]);
        this.logMsg('Heartbeat');
        this.wsSendData(HB);
    }
 
    //
    // Stop the active heartbeat timer, if one exists.
    //
    clearHeartbeat() {
        if (this._heartbeat) {
            clearInterval(this._heartbeat);
            this._heartbeat = null;
        }
    }
    //
    // Send data to the server (will be also logged in console)
    // @data the data to send 
    //
    wsSendData(data) {
        console.log("SEND: "+data);
        if (this._websocket) {
            this._websocket.send(data);
        }
        else {
            this.setStatus(ocpp.CP_ERROR,'No connection to OCPP server')
        }
    }
    
    //
    // @return the internal state of the CP
    //
    status() {
        return getSessionKey(ocpp.KEY_CP_STATUS);
    }
    
    //
    // Open the websocket and set internal state accordingly
    // @param wsurl The URL of the OCPP server
    // @param cpid  The charge point identifief (as defined in OCPP server)
    //
    wsConnect(wsurl,cpid) {
        if (this._websocket) {
            this.setStatus(ocpp.CP_ERROR,'Socket already opened. Closing it. Retry later');
            this._websocket.close(3001);
        } 
        else {

            // this._websocket = new WebSocket(wsurl + "" + cpid, ["ocpp1.6", "ocpp1.5"]);
            this._websocket = new WebSocket(wsurl + "" + cpid);
            var self = this

            //
            // OnOpen Callback
            //
            this._websocket.onopen = function(evt) {
                self.setStatus(ocpp.CP_CONNECTING);
                self.sendBootNotification();
            }

            //
            // OnError Callback
            //                  
            this._websocket.onerror = function(evt) {
                switch(self._websocket.readyState) {
                    case 1: // OPEN
                        self.setStatus(ocpp.CP_ERROR,'ws normal error: ' + evt.type)
                        break;
                    case 3: // CLOSED
                        setTimeout(() => self.wsConnect(wsurl, cpid), 1000);
                        self.setStatus(ocpp.CP_ERROR,'connection cannot be opened: ' + evt.type)
                        break;
                    default:
                        self.setStatus(ocpp.CP_ERROR,'websocket error: ' + evt.type)
                        break;
                }

            }

            //
            // OnMessage Callback
            // Decode the type of message and pass it to the appropriate handler
            // 
            this._websocket.onmessage = function(msg) {
                console.log("RECEIVE: "+msg.data);
                var ddata = (JSON.parse(msg.data));

                // Decrypt Message Type
                var msgType=ddata[0];
                switch(msgType) {
                    case ocpp.CALL: // CALL 
                        var id=ddata[1];
                        var request=ddata[2];
                        var payload=null;
                        if (ddata.length > 3) {
                            payload = ddata[3];
                        }
                        self.handleCallRequest(id,request,payload);
                        break;
                    case ocpp.CALLRESULT: // CALLRESULT 
                        self.handleCallResult(ddata[2]);
                        break;
                    case ocpp.CALLERROR: // CALLERROR
                        self.handleCallError(ddata[2],ddata[3]);
                        break;
                }
            }

            //
            // OnClose Callback
            //   
            this._websocket.onclose = function(evt) {
                self.clearHeartbeat();
                if (evt.code == 3001) {
                    self.setStatus(ocpp.CP_DISCONNECTED);
                    self.logMsg('Connection closed');
                    self._websocket = null;
                } else {
                    self.setStatus(ocpp.CP_ERROR,'Connection error: ' + evt.code);
                    self.logMsg('Connection error: ' + evt.code);
                    self._websocket = null;
                }
            }
        }
    }

    //
    // Close the websocket and set internal state accordingly
    //
    wsDisconnect() {
        this.clearHeartbeat();

        if (this._websocket) {
            this._websocket.close(3001);
        }
        this.setStatus(ocpp.CP_DISCONNECTED);
    }
    
    //
    // Return the meter value
    //
    meterValue() {
        return (getSessionKey(ocpp.KEY_METER_VALUE,"0"));
    }
    
    //
    // Set the meter value (and optionnally update the OCPP server with it)
    // @param v the new meter value
    // @param updateServer if set to true, update the server with the new meter value
    //
    setMeterValue(v,updateServer=false) {
        setSessionKey(ocpp.KEY_METER_VALUE,v);
        if (updateServer) {
            this.sendMeterValue();
        }
    }
    
    //
    // update the server with the internal meter value
    //
    sendMeterValue(c=0) {
        var mvreq={};
        this.setLastAction("MeterValues");
        var meter=getSessionKey(ocpp.KEY_METER_VALUE);
        var id=generateId();
        var ssid = getSessionKey('TransactionId');
        mvreq = JSON.stringify([ocpp.CALL, id, "MeterValues", {"connectorId": c, "transactionId": ssid, "meterValue": [{"timestamp": formatDate(new Date()), "sampledValue": [{"value": meter}]}]}]);
        this.logMsg("Send Meter Values: "+meter+" (connector " +c+")");
        this.wsSendData(mvreq);
    }
    
    //
    // Get the status of given connector
    // @param c connectorId
    // @return connector status as string
    //
    connectorStatus(c) {
        var key = ocpp.KEY_CONN_STATUS + c;
        return getSessionKey(key);
    }
    
    //
    // Update status of given connector
    // @param c connectorId
    // @param new status for connector
    // @param updateServer if true, also send a StatusNotification to server
    //
    setConnectorStatus(c,newStatus,updateServer=false) {
        var key = ocpp.KEY_CONN_STATUS + c;
        setSessionKey(key,newStatus);
        if(updateServer) {
            this.sendStatusNotification(c,newStatus);
        }
    }
    
    //
    // Send a StatusNotification to the server with the new status of the specified connector
    // @param c The connector id (0 for CP, 1 for connector 1, etc...)
    //
    sendStatusNotification(c) {
        var st=this.connectorStatus(c);
        this.setLastAction("StatusNotification");
        var id=generateId();
        var sn_req = JSON.stringify([ocpp.CALL, id, "StatusNotification", {
            "connectorId": c,
            "status": st,
            "errorCode": "NoError",
            "info": "",
            "timestamp": formatDate(new Date()),
            "vendorId": "",
            "vendorErrorCode": ""
        }]);
        this.logMsg("Sending StatusNotification for connector "+c+": "+st);
        this.wsSendData(sn_req);
    }
    
    //
    // Get availability for given connector
    // (availability is persistent thus stored in local storage instead of session storage)
    // @param c connector id
    // @return connector availability
    //
    availability(c=0) {
        var key = ocpp.KEY_CONN_AVAILABILITY + c;
        return getKey(key,ocpp.AVAILABITY_OPERATIVE);
    }

    //
    // Update the availability of given connector
    // (availability is set by remote server thus no "updateServer" flag as for connector status)
    // @param c connectorId
    // @param new availability for connector
    //
    setConnectorAvailability(c,newAvailability) {
        var key = ocpp.KEY_CONN_AVAILABILITY + c;
        setKey(key,newAvailability);
        if(newAvailability==ocpp.AVAILABITY_INOPERATIVE) {
            this.setConnectorStatus(c,ocpp.CONN_UNAVAILABLE,true);
        }
        else if(newAvailability==ocpp.AVAILABITY_OPERATIVE) {
            this.setConnectorStatus(c,ocpp.CONN_AVAILABLE,true);
        }
        if(this._availabilityChangeCb) {
            this._availabilityChangeCb(c,newAvailability);
        }
        if (Number(c)==0) {
            this.setConnectorAvailability(1,newAvailability);
            this.setConnectorAvailability(2,newAvailability);
        }
    }
}