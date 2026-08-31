"use strict";

//
// CONST definitions
//

// Keys (stored in local or session storage)
export const KEY_CP_STATUS    = 'cp_status';
export const KEY_METER_VALUE  = 'meter_value';
export const KEY_CONN_STATUS  = 'conn_status';
export const KEY_CONN0_STATUS  = 'conn_status0';
export const KEY_CONN1_STATUS  = 'conn_status1';
export const KEY_CONN2_STATUS  = 'conn_status2';
export const KEY_CONN_AVAILABILITY   = 'conn_availability';
export const KEY_CONN0_AVAILABILITY  = 'conn_availability0';
export const KEY_CONN1_AVAILABILITY  = 'conn_availability1';
export const KEY_CONN2_AVAILABILITY  = 'conn_availability2';
export const KEY_RESERVATIONS = 'reservations';

// ReservationStatus values
export const RESERVATION_STATUS_ACCEPTED = 'Accepted';
export const RESERVATION_STATUS_FAULT = 'Faulted';
export const RESERVATION_STATUS_OCCUPIED = 'Occupied';
export const RESERVATION_STATUS_REJECTED = 'Rejected';
export const RESERVATION_STATUS_UNAVAILABLE = 'Unavailable';
    
// Charge Point Status
export const CP_ERROR         = 'error';
export const CP_DISCONNECTED  = 'disconnected';
export const CP_CONNECTING    = 'connecting';
export const CP_CONNECTED     = 'connected';
export const CP_AUTHORIZED    = 'authorized';
export const CP_INTRANSACTION = 'in_transaction';

// Connector status
export const CONN_AVAILABLE   = 'Available';
export const CONN_PREPARING = 'Preparing';
export const CONN_CHARGING    = 'Charging';
export const CONN_SUSPENDED_EVSE = 'SuspendedEVSE';
export const CONN_SUSPENDED_EV = 'SuspendedEV';
export const CONN_FINISHING = 'Finishing';
export const CONN_RESERVED = 'Reserved';
export const CONN_UNAVAILABLE = 'Unavailable';
export const CONN_FAULTED = 'Faulted';

// Availability status
export const AVAILABITY_OPERATIVE   = 'Operative';
export const AVAILABITY_INOPERATIVE = 'Inoperative';

// Message type IDs
export const CALL = 2;
export const CALLRESULT = 3;
export const CALLERROR = 4;