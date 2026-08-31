"use strict";
/*global $ */

import ChargePoint from './ocpp_chargepoint.js';
import * as ocpp from './ocpp_constants.js'

//
// CONST definitions
//

// Keys (stored in local storage)
const WSURL = 'WSURL';
const CPID  = 'CPID';
const TAGID = 'TAG';
const APIURL = 'APIURL';
const METER_VALUE = 'METER_VALUE';

// the charge point
var _cp = new ChargePoint();

//
// Simulation Mode
//      null       = user has not chosen a mode yet
//      manual     = user controls Heartbeat, MeterValues, Start/Stop manually + Charger status
//      automated  = simulator automatically starts, send meter values, and stops
//
let simulationMode = null;

let currentChargepointPinRequired = true; // Tracks whether the current chargepoint requires a PIN or can connect without one

let transactionRunning = false; // true after the chargepoint enters CP_INTRANSACTION (Used to control automated MeterValues, auto-stop, and Abort button state)
let automatedPreparing = false; // true while automated mode is connecting, authorizing, or waiting backend to start the transaction (for "Connecting..." button)
let automatedFinishing = false; // true while automated mode is showing the Finishing delay (for "Finishing..." button)

// Timer IDs for meter value
let transactionTimerId = null;         // stores the auto-stop timer
let meterIntervalId = null;            // sends repeating MeterValues during automated charging
let statusTransitionTimerId = null;    // handles Preparing -> Charging and Finishing -> Available delays

// Delayed timers to demo Preparing and Finishing statuses (in milliseconds [5000ms = 5sec])
const PREPARING_DELAY = 5000; 
const FINISHING_DELAY = 5000;

// Log message to the JS Console and into the Log TextArea 
function logMsg(msg) {
    console.log(msg);
    var html_console = $('#console');
    html_console.append("&#10;" + msg);
    html_console.scrollTop(html_console.get(0).scrollHeight);
}

// -----------------------------------------------------------------------------
// Storage helpers
// -----------------------------------------------------------------------------

// Check if a value is empty
function isEmpty(str) {
    return (!str || 0 === str.length);
}

// Save a setting value to local storage
function setKey(key,value) {
    localStorage.setItem(key,value)
}

// Gets the default values for simulator settings
function keyDefaultValue(key) {
    const hosted = window.location.hostname === "api.evdrop.net";

    var v = "";

    switch(key) {
        case WSURL:
            v = hosted
                ? "wss://api.evdrop.net/ocpp-csms/chargepoint/"
                : "ws://localhost:5001/ocpp-csms/chargepoint/";
            break;

        case CPID:
            v = "CA_SIMULATED_CP_1";
            break;

        case TAGID:
            v = "DEADBEEF";
            break;

        case APIURL:
            v = "http://localhost:8000/api/v1";
            break;
        case APIURL:
            v = "http://localhost:8000/api/v1";
            break;
    }

    return v;
}

//
// Get simulator settings from local storage
//
// If the setting has not been saved yet, return to its default value instead
//
function getKey(key) {
    var v = localStorage.getItem(key);
    if (isEmpty(v)) {
        v = keyDefaultValue(key);
    }
    return v
}

// -----------------------------------------------------------------------------
// Screen helpers
// -----------------------------------------------------------------------------
// These functions control which main simulator screen is visible:
// 1. Setup screen: consists of two tabs
//      - PIN: UI changes based on chargepoint (PIN vs No-PIN)
//      - Settings: configure OCPP server URL, Chargepoint ID, OCPP version, and RFID tag
// 2. Mode screen: user chooses manual or automated simulation
// 3. Simulator app: main charger controls and logs
// 

// Setup screen
function showSetupScreen() {
    $('#setup_screen').show();
    $('#mode_screen').hide();
    $('#simulator_app').hide();
    $('#pin_error').hide();
}

//
// Update the PIN tab UI
//
// NOTE: This does not call the backend. It only changes the PIN input/button
// based on the result from refreshPinUiForChargepoint()
//
// PIN chargepoint:
//      - show the PIN input
//      - button says "Submit PIN"
//
// No-PIN chargepoint:
//      - hide the PIN input
//      - button says "Connect"
//
function setPinUiRequiresPin(requiresPin) {
    currentChargepointPinRequired = requiresPin;

    if (requiresPin) {
        $('#PIN').show();
        $('#PIN').val('');
        $('#PIN').attr('placeholder', 'PIN');
        $('#pin_submit').text('Submit PIN');
        $('#pin_error').hide();
    } else {
        $('#PIN').hide();
        $('#PIN').val('');
        $('#pin_submit').text('Connect');
        $('#pin_error').text('This chargepoint does not require a PIN.').removeClass('text-danger').addClass('text-muted').show();
    }
}

// Choose simulation mode screen
function showModeScreen() {
    $('#setup_screen').hide();
    $('#mode_screen').show();
    $('#simulator_app').hide();
}

// Simulator screen
function showSimulatorScreen() {
    $('#setup_screen').hide();
    $('#mode_screen').hide();
    $('#simulator_app').show();
}

// Clear PIN input helper
function clearPinInput() {
    $('#PIN').val('');
    $('#pin_error').hide();
}

// Reset meter value numbers
function resetMeterValue() {
    $("#metervalue").val(0);
    _cp.setMeterValue(0, false);
    localStorage.setItem(METER_VALUE, 0);
}

// Save meter value numbers
function saveMeterValue(value) {
    localStorage.setItem(METER_VALUE, value);
}

// Connector 1 Status
function setAutomatedConnectorStatus(status, sendNotification = false) {
    // Ignore automated connector status updates if on Manual mode
    if (simulationMode !== "automated") {
        return;
    }

    // Update Connector 1 and reflect the new status in the simulator
    _cp.setConnectorStatus(1, status, sendNotification);
    updateChargepointStatusBadge(status);
}

// Simulation Mode UI
function applySimulationModeUi() {
    // Automated
    if (simulationMode === "automated") {
        $('#send').hide(); // Authorize Button
        $('#start').hide(); // Start Transaction
        $('#heartbeat').hide(); // Heartbeat button
        $('#data_transfer').hide()
        $('#mv').hide();
        $('#mvplus').hide();

        // Hide manual status controls
        $('#status0').hide(); // Connector Availability (On/Off)
        $('#status1').hide(); // Connector Status

        $('#STATUS_CON0').prop('disabled', true);
        $('#STATUS_CON1').prop('disabled', true);

        $('#manual_chargepoint_status_controls').removeClass('d-flex').hide();
        $('#chargepoint_status_badge').show();

        $('#metervalue').prop('readonly', true);

        // Refresh Automated mode transaction button state
        updateAutomatedButtonState();
        return;
    }
    // Manual
    $('#send').hide(); // Authorize Button
    $('#start').show(); // Start Transaction
    $('#heartbeat').show(); // Heartbeat button
    $('#data_transfer').hide();
    $('#mv').show();
    $('#mvplus').show();

    // Show manual status controls
    $('#status0').show(); // Connector Availability (On/Off)
    $('#status1').show(); // Connector Status

    $('#STATUS_CON0').prop('disabled', false);
    $('#STATUS_CON1').prop('disabled', false);

    $('#manual_chargepoint_status_controls').show().addClass('d-flex');
    $('#chargepoint_status_badge').hide();

    $('#metervalue').prop('readonly', false);

    updateAutomatedButtonState();
}

//
// Clear automated transaction timers
// NOTE: Doesn't clear the chargepoint heartbeat timer
//
// This is called when
//      - the simulator disconnects
//      - an automated transaction stops
//      - an automated transaction is aborted
//
function clearTimers() {
    if (meterIntervalId) {
        clearInterval(meterIntervalId);
        meterIntervalId = null;
    }

    if (transactionTimerId) {
        clearTimeout(transactionTimerId);
        transactionTimerId = null;
    }

    if (statusTransitionTimerId) {
        clearTimeout(statusTransitionTimerId);
        statusTransitionTimerId = null;
    }
}

// -----------------------------------------------------------------------------
// Automated transaction helpers
// -----------------------------------------------------------------------------
//
// Automated mode simulates a REALISTIC charging session:
//      1. Connect, and report 'Preparing'
//      2. Wait for ActivateReservation/RemoteStartTransaction from backend
//      3. Enter 'Charging' when activated
//      4. Send MeterValues repeatedly
//      5. Stop automatically when the timer expires
//      6. Report 'Finishing' status, then back to 'Available'
//
function startAutoMeterValues() {

    const intervalSeconds = parseInt($("#auto_meter_interval").val() || "10");

    logMsg("[SIM] Auto MeterValues started");
    logMsg("[SIM] Meter interval: " + intervalSeconds + " seconds");

    // Repeatedly increase/add to the simulated meter reading and send a MeterValues
    // message to the OCPP server at the configured interval.
    meterIntervalId = setInterval(function() {
        let meter = parseInt($("#metervalue").val() || "0");

        // Simulating energy usage
        meter = meter + 10;

        $("#metervalue").val(meter);
        _cp.setMeterValue(meter, false);
        saveMeterValue(meter);
        _cp.sendMeterValue();

    }, intervalSeconds * 1000);
}

//
// Get the auto-stop timer settings from the UI
//
// @return { minutes: number, seconds: number, totalMs: number }
//
function getAutoStopTimerSettings() {
    const timerMinutes = parseInt($("#auto_timer_minutes").val() || "2");
    const timerSeconds = parseInt($("#auto_timer_seconds").val() || "0");

    return {
        minutes: timerMinutes,
        seconds: timerSeconds,
        totalMs: ((timerMinutes * 60) + timerSeconds) * 1000
    };
}

//
// Start the automated auto-stop timer after a transaction begins
//
// This timer only runs after the backend activates the reservation and
// the simulator enters CP_INTRANSACTION.
//
function startTransactionAutoStopTimer() {
    // Guard: Prevent duplicate auto-stop timers
    if (transactionTimerId) {
        return;
    }

    // Auto-stop timer
    const timer = getAutoStopTimerSettings();

    logMsg("[SIM] Auto-stop timer started: " + timer.minutes + " minutes, " + timer.seconds + " seconds");

    transactionTimerId = setTimeout(function () {
        transactionTimerId = null;

        if (transactionRunning) {
            logMsg("[SIM] Timer reached. Stopping transaction.");
            stopAutomatedTransaction();
        }
    }, timer.totalMs);
}

//
// Stop the automated charging flow.
//
// When clicked, shows Finishing, wait for FINISHING_DELAY,
// then sends StopTransaction and returns the connector to Available
//
function stopAutomatedTransaction() {
    if (!transactionRunning) {
        logMsg("[SIM] No transaction is running");
        return;
    }

    clearTimers();

    const tag = $("#TAG").val();

    // Tracks that automated transaction is Finishing
    automatedFinishing = true;
    updateAutomatedButtonState();

    logMsg("[SIM] Finishing automated transaction");
    setAutomatedConnectorStatus("Finishing", true);

    // Delays the end of charging to demo Finishing status, before becoming Available again
    statusTransitionTimerId = setTimeout(function () {
        statusTransitionTimerId = null;

        _cp.setMeterValue($("#metervalue").val(), false);
        _cp.stopTransaction(tag);

        automatedFinishing = false;
        transactionRunning = false;

        setAutomatedConnectorStatus("Available", true);

        updateAutomatedButtonState();

        logMsg("[SIM] Automated transaction stopped");

    }, FINISHING_DELAY);
}

//
// Update the automated mode transaction button
//
// The button shows the current automated charging state
//
function updateAutomatedButtonState() {
    /* 
        btn-primary   = blue
        btn-danger    = red
        btn-secondary = gray
    */

    // Manual mode always uses the Stop Transaction button
    if (simulationMode !== "automated") {
        $('#stop').show();
        $('#stop').text("Stop Transaction");
        $('#stop').prop('disabled', false);
        $('#stop').removeClass("btn-danger btn-secondary").addClass("btn-primary");
        return;
    }

    // Automated mode does not let the user start a transaction manually
    // The backend starts the transaction through activateReservation / RemoteStartTransaction
    if (!transactionRunning && !automatedPreparing && !automatedFinishing) {
        $('#stop').hide();
        return;
    }

    $('#stop').show();

    // If automated mode is preparing or finishing, show a disabled status button
    if (automatedPreparing || automatedFinishing) {
        $('#stop').text(automatedPreparing ? "Connecting..." : "Finishing...");
        $('#stop').prop('disabled', true);
        $('#stop').removeClass("btn-primary btn-danger").addClass("btn-secondary");
        return;
    }

    // If a backend-started transaction is running, allow the user to abort/stop it
    if (transactionRunning) {
        $('#stop').text("Abort Transaction");
        $('#stop').prop('disabled', false);
        $('#stop').removeClass("btn-primary btn-secondary").addClass("btn-danger");
    }
}

// -----------------------------------------------------------------------------
// OCPP Callbacks:
// -----------------------------------------------------------------------------
//
//      CP_DISCONNECTED  -> return to Setup Screen
//      CP_CONNECTING    -> Preparing
//      CP_CONNECTED     -> Waiting for backend activation
//      CP_AUTHORIZED    -> Status before Charging
//      CP_INTRANSACTION -> Charging
//      CP_ERROR         -> Faulted
//
function statusChangeCb(s,msg) {
    $('.indicator').hide();
    
    switch(s){
        case ocpp.CP_DISCONNECTED:
            $('#badge_disconnected').show();
            $('#disconnect').hide();

            clearTimers();

            transactionRunning = false; 
            automatedPreparing = false; 
            automatedFinishing = false; 

            clearPinInput();
            showSetupScreen();

            break;

        case ocpp.CP_CONNECTING:
            $('#badge_connecting').show();
            $('#disconnect').show(); 

            break;

        case ocpp.CP_CONNECTED:
            $('#badge_connected').show();
            $('#disconnect').show();

            automatedPreparing = false;
            updateAutomatedButtonState();
            
            // If Automated mode:
            //      - set connector status to Preparing
            //      - wait for reservation activation
            // If Manual:
            //      - waiting for user interaction
            if (simulationMode === "automated") {
                setAutomatedConnectorStatus("Preparing", true);

                logMsg("[SIM] Connected. Waiting for reservation activation.");
            } else {
                logMsg("[SIM] Manual mode connected. Waiting for action.");
            }
            
            break;

        case ocpp.CP_AUTHORIZED:
            $('#badge_available').show();

            automatedPreparing = false;
            updateAutomatedButtonState();

            // When transaction is started, it is authorized
            if (simulationMode === "automated") {
                logMsg("[SIM] Authorization accepted. Starting transaction.");
            } else {
                _cp.setConnectorStatus(1, "Available", true);
            }

            break;

        case ocpp.CP_INTRANSACTION:
            $('#badge_transaction').show();

            transactionRunning = true;
            automatedFinishing = false;

            // If Automated mode AND in-transaction:
            //      - simulate a vehicle plug-in by sending connector Preparing status automatically
            //      - shortly after, update connector status to Charging and start meter values + auto-stop timer
            if (simulationMode === "automated"){
                //
                // Simulate vehicle plug-in
                //
                automatedPreparing = true;
                updateAutomatedButtonState();

                setAutomatedConnectorStatus("Preparing", true);

                statusTransitionTimerId = setTimeout(function () {
                    statusTransitionTimerId = null;

                    automatedPreparing = false;

                    // Connector status shows charging
                    setAutomatedConnectorStatus("Charging", true);

                    logMsg("[SIM] Connector 1 entered Charging");

                    startAutoMeterValues();
                    startTransactionAutoStopTimer();

                    updateAutomatedButtonState();

                }, PREPARING_DELAY);
            } else {
                // Manual mode controls connector status itself
                automatedPreparing = false;
                updateAutomatedButtonState();
            }

            break;

        case ocpp.CP_ERROR:
            $('#badge_error').show();

            if (simulationMode === "automated") {
                setAutomatedConnectorStatus("Faulted", true);
            } else {
                _cp.setConnectorStatus(1, "Faulted", true);
            }

            if (!isEmpty(msg)) {
                logMsg(msg)
            }

            break;

        default:
            $('#badge_error').show();

            if (simulationMode === "automated") {
                setAutomatedConnectorStatus("Faulted", true);
            } else {
                _cp.setConnectorStatus(1, "Faulted", true);
            }
            
            if (!isEmpty(msg)) {
                logMsg(msg)
            }
            else {
                logMsg("ERROR: Unknown status")
            }
    }
}

//
// Update the automated chargepoint status badge
//
// This badge is used in automated mode instead of the manual status dropdown.
// It changes the badge text and color based on the current charge point status.
//
function updateChargepointStatusBadge(status) {
    const badge = $('#chargepoint_status_badge');

    badge
        .text(status)
        .removeClass('badge-success badge-warning badge-primary badge-secondary badge-danger badge-dark');

    switch (status) {
        case "Available":
            badge.addClass('badge-success');
            break;

        case "Preparing":
            badge.addClass('badge-warning');
            break;

        case "Charging":
            badge.addClass('badge-primary');
            break;

        case "Finishing":
            badge.addClass('badge-secondary');
            break;

        case "Faulted":
            badge.addClass('badge-danger');
            break;

        default:
            badge.addClass('badge-dark');
            break;
    }
}

//
// Availability change callback
//
// Called when the charge point availability changes, usually from a
// ChangeAvailability request sent by the OCPP server.
//
// It updates the UI fields for the selected connector:
// - availability dropdown
// - connector status dropdown
//
function availabilityChangeCb(c,s) {    
    var dom_id="#AVAILABILITY_CON"+c;
    $(dom_id).val(s);
    var dom_id="#STATUS_CON"+c;
    $(dom_id).val(_cp.connectorStatus(c));
}

//
// Backend PIN validation
//
// It sends the selected chargepoint OCPP id and entered-PIN to the backend. 
// The backend decides whether:
//      - the charge point exists
//      - a PIN is required
//      - the submitted PIN is valid
//
async function validateChargepointPin(chargepointId, pin) {
    const apiUrl = getKey(APIURL).replace(/\/$/, '');
    const url = `${apiUrl}/validateChargepointPin`;

    console.log("[PIN] Sending validation request", {
        url,
        chargepointId,
        pinProvided: Boolean(pin)
    });

    let response;

    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                chargepoint_ocpp_id: chargepointId,
                pin: pin
            })
        });
    } catch (err) {
        console.error("[PIN] Network request failed", {
            url,
            chargepointId,
            errorName: err.name,
            errorMessage: err.message,
            browserOnline: navigator.onLine
        });

        const message = navigator.onLine
            ? "Unable to connect to the Django API."
            : "Browser is offline.";

        logMsg(`[SIM] PIN validation failed: ${message}`);
        logMsg(`[SIM] API URL: ${url}`);

        throw new Error(message);
    }

    console.log("[PIN] Backend response received", {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok
    });

    const rawText = await response.text();

    console.log("[PIN] Backend response body", rawText);

    let data = {};

    try {
        data = JSON.parse(rawText);
    } catch (err) {
        console.error("[PIN] Backend returned invalid JSON", {
            rawText,
            errorName: err.name,
            errorMessage: err.message
        });

        throw new Error("Backend returned non-JSON response.");
    }

    if (!response.ok) {
        const message =
            data.message ||
            data.detail ||
            "PIN validation failed.";

        console.warn("[PIN] Validation rejected", {
            status: response.status,
            message,
            data
        });

        // Preserve Django's real message:
        // "PIN is required.", "Invalid PIN.", etc.
        throw new Error(message);
    }

    console.log("[PIN] Validation successful", {
        chargepointId,
        pinRequired: data.pin_required,
        chargepointIdFromBackend: data.chargepoint_id
    });

    return data;
}

//
// Refresh the PIN input format based on the selected chargepoint (PIN vs No-PIN chargepoint).
//
// Checks the backend to determine whether the selected charge point requires a PIN. Based on the response, 
// it updates the PIN tab to either:
//      - show the PIN input and "Submit PIN" button
//      - hide the PIN input and show a "Connect" button
//
async function refreshPinUiForChargepoint() {
    const chargepointId = getKey(CPID);

    // GUARD: If there is no chargepoint id selected, show a red “ChargePoint ID is required” error and stop the PIN check
    if (isEmpty(chargepointId)) {
        setPinUiRequiresPin(true);
        $('#pin_error').text('ChargePoint ID is required.').removeClass('text-muted').addClass('text-danger').show();
        return;
    }

    // Check backend whether selected chargepoint requires a PIN
    try {
        const result = await validateChargepointPin(chargepointId, '');

        if (result.pin_required === false) {
            setPinUiRequiresPin(false);
        } else {
            setPinUiRequiresPin(true);
        }

    } catch (err) {
        // ERROR: If backend says PIN is required, that means this chargepoint exists but needs a PIN setup
        if ((err.message || '').toLowerCase().includes('pin is required')) {
            setPinUiRequiresPin(true);
            return;
        }

        // ERROR: Generic error message
        setPinUiRequiresPin(true);
        $('#pin_error').text(err.message || 'Could not check chargepoint PIN setting.').removeClass('text-muted').addClass('text-danger').show();
    }
}

//
// Entry point of the simulator
// (attach callbacks to each button and wait for user action)
//
$( document ).ready(function() {
    //
    // Initial screen state
    //
    showSetupScreen();

    _cp.setLoggingCallback(logMsg);
    _cp.setStatusChangeCallback(statusChangeCb);
    _cp.setAvailabilityChangeCallback(availabilityChangeCb);
    _cp.setStatus(ocpp.CP_DISCONNECTED);

    // Init the setting form
    $('#WSURL').val(getKey(WSURL))
    $('#CPID').val(getKey(CPID))
    $('#TAG').val(getKey(TAGID))
    refreshPinUiForChargepoint();

    // Reset meter value to 0
    const savedMeterValue = localStorage.getItem(METER_VALUE) || 0;
    $("#metervalue").val(savedMeterValue);
    _cp.setMeterValue(savedMeterValue, false);

    //availabilityChangeCb(0,_cp.availability(0));
    //availabilityChangeCb(1,_cp.availability(1));

    // Define settings call back
    $('#cpparams').submit(function(e) {
        e.preventDefault();

        const formData = new FormData(e.target);

        for (var pair of formData.entries()) {
            setKey(pair[0], pair[1]);
        }

        logMsg("[SIM] Settings saved");

        refreshPinUiForChargepoint();
    });

    //
    // PIN SUBMIT BUTTON: Validate PIN and show mode selection screen
    //
    $('#pin_submit').click(async function () {
        const pin = currentChargepointPinRequired ? ($("#PIN").val() || "").trim() : "";
        const chargepointId = getKey(CPID);

        $('#pin_error').hide().removeClass('text-muted').addClass('text-danger');

        // GUARD: Chargepoint ID is required
        if (isEmpty(chargepointId)) {
            $('#pin_error').text("ChargePoint ID is required.").show();
            logMsg("[SIM] ChargePoint ID is required");
            return;
        }


        try {
            // Log whether the user is submitting a PIN or continuing with a no-PIN chargepoint.
            if (currentChargepointPinRequired) {
                logMsg("[SIM] Validating PIN for charge point " + chargepointId);
            } else {
                logMsg("[SIM] Connecting no-PIN charge point " + chargepointId);
            }

            // Validate the selected chargepoint and PIN/no-PIN access with the backend
            const result = await validateChargepointPin(chargepointId, pin);

            // Clear the PIN field + hide any previous error message after successful validation
            $('#PIN').val('');
            $('#pin_error').hide();

            // PIN validation passed -> so move to simulation mode selection screen
            showModeScreen();

            // Log whether the backend accepted a PIN OR confirmed that no PIN was required
            if (result.pin_required === false) {
                logMsg("[SIM] PIN not required");
            } else {
                logMsg("[SIM] PIN accepted");
            }

            // NOTE: The simulator doesn't connect to OCPP here yet
            // The WebSocket connection starts only after the user chooses Manual or Automated mode
            logMsg("[SIM] Choose a simulation mode to connect chargepoint " + chargepointId);

            $('.indicator').hide();

        } catch (err) {
            // Show backend validation errors, such as invalid PIN or unknown charge point
            $('#pin_error').text(err.message || "Invalid PIN").removeClass('text-muted').addClass('text-danger').show();
            logMsg("[SIM] PIN validation failed: " + err.message);
        }
    });

    // Manual Option
    $('#mode_manual').click(function () {
        const chargepointId = getKey(CPID);

        simulationMode = "manual";

        showSimulatorScreen();
        applySimulationModeUi();

        logMsg("[SIM] Manual simulation selected");

        $('.indicator').hide();
        _cp.wsConnect(getKey(WSURL), chargepointId); 
    });

    // Automated Option
    $('#mode_automated').click(function () {
        const chargepointId = getKey(CPID);

        // Auto-stop timer
        const timer = getAutoStopTimerSettings();

        // Guard: Automated mode needs an auto-stop timer so charging does not run forever
        if (timer.totalMs <= 0) {
            logMsg("[SIM] Auto-stop timer must be greater than 0 seconds.");
            alert("Auto-stop timer must be greater than 0 seconds.");
            return;
        }

        simulationMode = "automated";
        automatedPreparing = true;

        showSimulatorScreen();
        applySimulationModeUi();
        updateAutomatedButtonState();

        logMsg("[SIM] Automated mode selected. Waiting for backend activation.");

        $('.indicator').hide();
        _cp.wsConnect(getKey(WSURL), chargepointId);
    });

/*     $('#connect').click(function () {
        $('.indicator').hide();
        _cp.wsConnect(getKey(WSURL),getKey(CPID));
    }); */

    $('#disconnect').click(function () {
        _cp.wsDisconnect();
    });
    
    $('#send').click(function () {
        _cp.authorize($("#TAG").val());
    }); 

    $('#start').click(function () {
        _cp.setMeterValue($("#metervalue").val(),false);
        _cp.startTransaction($("#TAG").val());
    });


    //
    // Stop button
    //
    // Automated: If charging status is Preparing/Finishing, log changing in state is in progress
    $('#stop').click(function () {
        if (simulationMode === "automated") {
            if (automatedPreparing || automatedFinishing) {
                logMsg("[SIM] Please wait. Automated transaction is changing state.");
                return;
            }
            
            if (transactionRunning) {
                stopAutomatedTransaction();
            } else {
                logMsg("[SIM] Waiting for backend activation. Call activateReservation to start the transaction.");
            }
            return;
        }

        _cp.setMeterValue($("#metervalue").val(), false);
        _cp.stopTransaction($("#TAG").val());

        _cp.setConnectorStatus(1, "Available", true);
    });

    $('#mv').click(function () {
        const meter = $("#metervalue").val();
        _cp.setMeterValue(meter, false);
        saveMeterValue(meter);
        _cp.sendMeterValue();
    });

    $("#mvplus").click(function(){
        var meter = $("#metervalue").val();
        meter = parseInt(meter) + 10;

        $("#metervalue").val(meter); 
        _cp.setMeterValue(meter,false);
        saveMeterValue(meter);
    });

    $('#reset_meter').click(function () {
        resetMeterValue();
        logMsg("[SIM] Meter value reset to 0");
    });

    $('#heartbeat').click(function () {
        _cp.sendHeartbeat();
    });

    // Connector Status Handlers
    $('#CP0_STATUS').change(function () {
        _cp.setConnectorStatus(0,$("#STATUS_CON0").val(),false);
    });
    $('#CP1_STATUS').change(function () {
        _cp.setConnectorStatus(1,$("#STATUS_CON1").val(),false);
    });
    $('#status0').click(function () { 
        _cp.setConnectorStatus(0,$("#STATUS_CON0").val(),true);
    });
    $('#status1').click(function () {
        _cp.setConnectorStatus(1,$("#STATUS_CON1").val(),true);
    });

    $('#data_transfer').click(function () {
        /*
        setLastAction("DataTransfer");
        var id=generateId();
        var DT = JSON.stringify([2,id, "DataTransfer", {
            "vendorId": "rus.avt.cp",
            "messageId": "GetChargeInstruction",
            "data": ""
        }]);
        wsSendData(DT);
        */
    });

    $('#connect').on('change', function () {
        /* if (_websocket) {
            _websocket.close(3001);
        }*/
    });

    logMsg("OCPP Simulator ready");
});