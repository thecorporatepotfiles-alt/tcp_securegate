/**
 * Shared domain vocabulary for TCP SecureGate.
 * Imported by both the API server and the web client so labels, codes and
 * default rules never drift apart.
 */

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLES = ['SYSTEM_ADMIN', 'HQ_ADMIN', 'LOCATION_ADMIN', 'HOST', 'GUARD', 'AUDITOR'] as const;
export type RoleCode = (typeof ROLES)[number];

export const ROLE_INFO: Record<RoleCode, { name: string; description: string; rank: number; allLocations: boolean }> = {
  SYSTEM_ADMIN: {
    name: 'System Administrator',
    description: 'Configures organizations, locations, gates, users, roles and system settings.',
    rank: 100,
    allLocations: true,
  },
  HQ_ADMIN: {
    name: 'HQ Administrator',
    description: 'Consolidated visibility across all authorized locations.',
    rank: 80,
    allLocations: true,
  },
  LOCATION_ADMIN: {
    name: 'Location Administrator',
    description: 'Manages users, gates and records for an assigned location.',
    rank: 60,
    allLocations: false,
  },
  HOST: {
    name: 'Approving Officer / Host',
    description: 'Creates visitor requests and reviews requests assigned to them.',
    rank: 40,
    allLocations: false,
  },
  GUARD: {
    name: 'Security Guard',
    description: 'Operates the simplified gate interface at assigned gates.',
    rank: 30,
    allLocations: false,
  },
  AUDITOR: {
    name: 'Auditor (Read-only)',
    description: 'Reads authorized records, reports and audit history. Cannot modify records.',
    rank: 20,
    allLocations: true,
  },
};

/** Roles a given role may assign when managing users. Enforced server-side. */
export const ASSIGNABLE_ROLES: Record<RoleCode, RoleCode[]> = {
  SYSTEM_ADMIN: [...ROLES],
  HQ_ADMIN: [],
  LOCATION_ADMIN: ['HOST', 'GUARD'],
  HOST: [],
  GUARD: [],
  AUDITOR: [],
};

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export const PERMISSIONS = {
  'dashboard.view': { group: 'Overview', description: 'View management dashboard' },
  'presence.view': { group: 'Overview', description: 'View "Who Is Inside?" status' },
  'events.view': { group: 'Gate register', description: 'View entry–exit events and the unified gate register' },
  'events.correct': { group: 'Gate register', description: 'Record auditable corrections to movement events' },
  'gate.operate': { group: 'Gate operations', description: 'Use the gate interface: verify, record entry/exit, register arrivals' },
  'gate.manual_review': { group: 'Gate operations', description: 'Decide manual-review requests raised at the gate' },
  'personnel.view': { group: 'Personnel', description: 'View personnel directory and records' },
  'personnel.manage': { group: 'Personnel', description: 'Create, edit, activate and deactivate personnel' },
  'credentials.view': { group: 'Credentials', description: 'View credentials and credential history' },
  'credentials.manage': { group: 'Credentials', description: 'Assign, block, replace and deactivate credentials' },
  'visitors.view': { group: 'Visitors', description: 'View own visitor requests (as host, requester or approver)' },
  'visitors.view_all': { group: 'Visitors', description: 'View all visitor records in authorized locations' },
  'visitors.create': { group: 'Visitors', description: 'Create visitor requests' },
  'visitors.approve': { group: 'Visitors', description: 'Approve or reject visitor requests assigned to the user' },
  'visitors.security_check': { group: 'Visitors', description: 'Record completion of required security verification step' },
  'visitors.manage': { group: 'Visitors', description: 'Cancel or administer any visitor request in scope' },
  'contractors.view': { group: 'Contractors', description: 'View contractors, vendors and service personnel' },
  'contractors.manage': { group: 'Contractors', description: 'Manage contractors, vendors and service personnel' },
  'temp_access.view': { group: 'Temporary access', description: 'View temporary access records' },
  'temp_access.manage': { group: 'Temporary access', description: 'Issue and revoke temporary access' },
  'vehicles.view': { group: 'Vehicles', description: 'View vehicle register and movement' },
  'vehicles.manage': { group: 'Vehicles', description: 'Register vehicles and change authorization status' },
  'deliveries.view': { group: 'Deliveries', description: 'View the delivery register' },
  'deliveries.manage': { group: 'Deliveries', description: 'Register and administer deliveries' },
  'deliveries.authorize': { group: 'Deliveries', description: 'Authorize deliveries to proceed under applicable procedures' },
  'deliveries.acknowledge': { group: 'Deliveries', description: 'Acknowledge receipt of deliveries addressed to the user' },
  'alerts.view': { group: 'Alerts & exceptions', description: 'View alerts' },
  'alerts.acknowledge': { group: 'Alerts & exceptions', description: 'Acknowledge alerts' },
  'alerts.resolve': { group: 'Alerts & exceptions', description: 'Resolve alerts with a resolution note' },
  'exceptions.view': { group: 'Alerts & exceptions', description: 'View administrative exceptions and handovers' },
  'exceptions.manage': { group: 'Alerts & exceptions', description: 'Create, review and resolve administrative exceptions' },
  'handover.manage': { group: 'Alerts & exceptions', description: 'Record and acknowledge shift handovers' },
  'reports.view': { group: 'Reports & audit', description: 'View reports' },
  'reports.export': { group: 'Reports & audit', description: 'Export reports to CSV' },
  'audit.view': { group: 'Reports & audit', description: 'View audit history' },
  'users.manage': { group: 'Administration', description: 'Manage user accounts (within assignable roles and locations)' },
  'roles.manage': { group: 'Administration', description: 'Configure role permissions' },
  'locations.manage': { group: 'Administration', description: 'Manage locations and gates' },
  'settings.manage': { group: 'Administration', description: 'Change system settings and workflow rules' },
  'demo.reset': { group: 'Administration', description: 'Reset the demonstration dataset (demo mode only)' },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const READ_ONLY_OVERSIGHT: Permission[] = [
  'dashboard.view',
  'presence.view',
  'events.view',
  'personnel.view',
  'credentials.view',
  'visitors.view',
  'visitors.view_all',
  'contractors.view',
  'temp_access.view',
  'vehicles.view',
  'deliveries.view',
  'alerts.view',
  'exceptions.view',
  'reports.view',
  'reports.export',
  'audit.view',
];

export const DEFAULT_ROLE_PERMISSIONS: Record<RoleCode, Permission[]> = {
  SYSTEM_ADMIN: [...ALL_PERMISSIONS],
  HQ_ADMIN: [...READ_ONLY_OVERSIGHT, 'alerts.acknowledge', 'alerts.resolve', 'exceptions.manage'],
  LOCATION_ADMIN: [
    ...READ_ONLY_OVERSIGHT,
    'events.correct',
    'gate.manual_review',
    'personnel.manage',
    'credentials.manage',
    'visitors.create',
    'visitors.security_check',
    'visitors.manage',
    'contractors.manage',
    'temp_access.manage',
    'vehicles.manage',
    'deliveries.manage',
    'deliveries.authorize',
    'alerts.acknowledge',
    'alerts.resolve',
    'exceptions.manage',
    'handover.manage',
    'users.manage',
    'locations.manage',
  ],
  HOST: ['visitors.view', 'visitors.create', 'visitors.approve', 'deliveries.acknowledge'],
  GUARD: ['gate.operate', 'alerts.view', 'alerts.acknowledge', 'handover.manage'],
  AUDITOR: [...READ_ONLY_OVERSIGHT],
};

/** Permissions that must never be removed from SYSTEM_ADMIN (prevents lock-out). */
export const LOCKED_ADMIN_PERMISSIONS: Permission[] = ['roles.manage', 'users.manage', 'settings.manage'];

// ---------------------------------------------------------------------------
// Visual tone used by the UI for status badges
// ---------------------------------------------------------------------------

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

// ---------------------------------------------------------------------------
// Visitor statuses & transitions
// ---------------------------------------------------------------------------

export const VISIT_STATUSES = [
  'EXPECTED',
  'ARRIVED',
  'HOST_NOTIFIED',
  'WAITING',
  'APPROVED',
  'INSIDE',
  'OVERDUE',
  'EXITED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const VISIT_STATUS_INFO: Record<VisitStatus, { label: string; tone: Tone; description: string }> = {
  EXPECTED: { label: 'Expected', tone: 'warning', description: 'Pre-registered; awaiting authorization' },
  ARRIVED: { label: 'Arrived', tone: 'warning', description: 'Reported at the gate; host not yet notified' },
  HOST_NOTIFIED: { label: 'Host Notified', tone: 'warning', description: 'Host notified; awaiting host acknowledgement' },
  WAITING: { label: 'Waiting', tone: 'warning', description: 'Host acknowledged; awaiting authorization' },
  APPROVED: { label: 'Approved', tone: 'info', description: 'Authorized; not yet recorded inside' },
  INSIDE: { label: 'Inside', tone: 'success', description: 'Entry recorded' },
  OVERDUE: { label: 'Overdue', tone: 'danger', description: 'Inside beyond expected departure' },
  EXITED: { label: 'Exited', tone: 'neutral', description: 'Exit recorded; visit complete' },
  REJECTED: { label: 'Rejected', tone: 'danger', description: 'Request rejected' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', description: 'Request cancelled' },
  EXPIRED: { label: 'Expired', tone: 'neutral', description: 'Validity window passed without entry' },
};

/** Statuses that still need an authorization decision. */
export const VISIT_AWAITING_AUTHORIZATION: VisitStatus[] = ['EXPECTED', 'ARRIVED', 'HOST_NOTIFIED', 'WAITING'];
export const VISIT_TERMINAL: VisitStatus[] = ['EXITED', 'REJECTED', 'CANCELLED', 'EXPIRED'];

/**
 * Default permitted transitions (configurable by a System Administrator under
 * Settings → Workflow rules). The server rejects any transition not listed.
 * INSIDE / EXITED can only be reached through recorded movement events.
 */
export const DEFAULT_VISIT_TRANSITIONS: Record<VisitStatus, VisitStatus[]> = {
  EXPECTED: ['ARRIVED', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  ARRIVED: ['HOST_NOTIFIED', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  HOST_NOTIFIED: ['WAITING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  WAITING: ['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  APPROVED: ['INSIDE', 'CANCELLED', 'EXPIRED'],
  INSIDE: ['EXITED', 'OVERDUE', 'APPROVED'],
  OVERDUE: ['EXITED', 'INSIDE', 'APPROVED'],
  EXITED: ['INSIDE', 'OVERDUE'],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
};
// Note: INSIDE→APPROVED, OVERDUE→INSIDE/APPROVED and EXITED→INSIDE/OVERDUE exist
// only so authorized event corrections can re-derive status from events.

// ---------------------------------------------------------------------------
// Delivery statuses & transitions
// ---------------------------------------------------------------------------

export const DELIVERY_STATUSES = [
  'EXPECTED',
  'ARRIVED',
  'AWAITING_AUTHORIZATION',
  'AUTHORIZED',
  'RECEIVED',
  'DEPARTED',
  'REJECTED',
  'CANCELLED',
  'RETURNED',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_STATUS_INFO: Record<DeliveryStatus, { label: string; tone: Tone; description: string }> = {
  EXPECTED: { label: 'Expected', tone: 'neutral', description: 'Pre-registered; not yet arrived' },
  ARRIVED: { label: 'Arrived', tone: 'warning', description: 'Arrival recorded at the gate' },
  AWAITING_AUTHORIZATION: { label: 'Awaiting Authorization', tone: 'warning', description: 'Waiting for an authorized decision' },
  AUTHORIZED: {
    label: 'Authorized to Proceed',
    tone: 'info',
    description: 'Authorized to proceed under applicable procedures. Not proof of inspection or acceptance.',
  },
  RECEIVED: { label: 'Received', tone: 'success', description: 'Receipt acknowledged by recipient' },
  DEPARTED: { label: 'Departed', tone: 'neutral', description: 'Delivery completed and courier departed' },
  REJECTED: { label: 'Rejected', tone: 'danger', description: 'Delivery rejected' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', description: 'Delivery cancelled' },
  RETURNED: { label: 'Returned', tone: 'neutral', description: 'Delivery returned with courier' },
};

export const DELIVERY_AWAITING_COMPLETION: DeliveryStatus[] = ['ARRIVED', 'AWAITING_AUTHORIZATION', 'AUTHORIZED'];

export const DEFAULT_DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  EXPECTED: ['ARRIVED', 'CANCELLED'],
  ARRIVED: ['AWAITING_AUTHORIZATION', 'AUTHORIZED', 'REJECTED', 'RETURNED', 'CANCELLED'],
  AWAITING_AUTHORIZATION: ['AUTHORIZED', 'REJECTED', 'RETURNED', 'CANCELLED'],
  AUTHORIZED: ['RECEIVED', 'REJECTED', 'RETURNED'],
  RECEIVED: ['DEPARTED'],
  DEPARTED: [],
  REJECTED: [],
  CANCELLED: [],
  RETURNED: [],
};

export const DEFAULT_DELIVERY_CATEGORIES = [
  { code: 'COURIER', label: 'Courier service' },
  { code: 'PARCEL', label: 'Parcel delivery' },
  { code: 'FOOD', label: 'Food delivery' },
  { code: 'SUPPLIER', label: 'Supplier delivery' },
  { code: 'OTHER', label: 'Other authorized delivery' },
];

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export const DEFAULT_VEHICLE_CATEGORIES = [
  { code: 'CAR', label: 'Car' },
  { code: 'MOTORCYCLE', label: 'Motorcycle' },
  { code: 'VAN', label: 'Van' },
  { code: 'DELIVERY_VEHICLE', label: 'Delivery vehicle' },
  { code: 'TRUCK', label: 'Truck' },
  { code: 'SERVICE_VEHICLE', label: 'Service vehicle' },
  { code: 'OTHER', label: 'Other' },
];

export const VEHICLE_AUTH_STATUSES = ['AUTHORIZED', 'PENDING', 'NOT_AUTHORIZED', 'BLOCKED'] as const;
export type VehicleAuthStatus = (typeof VEHICLE_AUTH_STATUSES)[number];
export const VEHICLE_AUTH_INFO: Record<VehicleAuthStatus, { label: string; tone: Tone }> = {
  AUTHORIZED: { label: 'Authorized', tone: 'success' },
  PENDING: { label: 'Pending review', tone: 'warning' },
  NOT_AUTHORIZED: { label: 'Not authorized', tone: 'danger' },
  BLOCKED: { label: 'Blocked', tone: 'danger' },
};

export const VEHICLE_OWNER_TYPES = ['PERSONNEL', 'VISITOR', 'CONTRACTOR', 'DELIVERY', 'ESTABLISHMENT', 'OTHER'] as const;
export type VehicleOwnerType = (typeof VEHICLE_OWNER_TYPES)[number];

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export const CREDENTIAL_TYPES = ['RFID_CARD', 'NFC_CARD', 'NFC_TAG', 'TEMPORARY_CARD'] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];
export const CREDENTIAL_TYPE_LABEL: Record<CredentialType, string> = {
  RFID_CARD: 'RFID card',
  NFC_CARD: 'NFC card',
  NFC_TAG: 'NFC tag',
  TEMPORARY_CARD: 'Temporary card',
};

export const CREDENTIAL_STATUSES = ['ACTIVE', 'INACTIVE', 'BLOCKED', 'LOST', 'REPLACED', 'EXPIRED'] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];
export const CREDENTIAL_STATUS_INFO: Record<CredentialStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  INACTIVE: { label: 'Inactive', tone: 'neutral' },
  BLOCKED: { label: 'Blocked', tone: 'danger' },
  LOST: { label: 'Reported lost', tone: 'danger' },
  REPLACED: { label: 'Replaced', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
};

// ---------------------------------------------------------------------------
// Contractors / temporary access
// ---------------------------------------------------------------------------

export const CONTRACTOR_CATEGORIES = ['CONTRACTOR', 'VENDOR', 'SERVICE'] as const;
export type ContractorCategory = (typeof CONTRACTOR_CATEGORIES)[number];
export const CONTRACTOR_CATEGORY_LABEL: Record<ContractorCategory, string> = {
  CONTRACTOR: 'Contractor',
  VENDOR: 'Vendor / supplier',
  SERVICE: 'Service personnel',
};

export const TEMP_HOLDER_TYPES = ['PERSONNEL', 'CONTRACTOR', 'INDIVIDUAL'] as const;
export type TempHolderType = (typeof TEMP_HOLDER_TYPES)[number];

// ---------------------------------------------------------------------------
// Movement subjects, register categories & events
// ---------------------------------------------------------------------------

export const SUBJECT_TYPES = ['PERSONNEL', 'VISITOR', 'CONTRACTOR', 'TEMPORARY', 'DELIVERY', 'VEHICLE'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const REGISTER_CATEGORIES = ['PERSONNEL', 'VISITOR', 'CONTRACTOR', 'VENDOR', 'SERVICE', 'TEMPORARY', 'DELIVERY', 'VEHICLE'] as const;
export type RegisterCategory = (typeof REGISTER_CATEGORIES)[number];
export const REGISTER_CATEGORY_LABEL: Record<RegisterCategory, string> = {
  PERSONNEL: 'Personnel',
  VISITOR: 'Visitor',
  CONTRACTOR: 'Contractor',
  VENDOR: 'Vendor',
  SERVICE: 'Service personnel',
  TEMPORARY: 'Temporary access',
  DELIVERY: 'Delivery personnel',
  VEHICLE: 'Vehicle',
};

export const EVENT_TYPES = ['ENTRY', 'EXIT'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const GATE_MODES = ['PERSONNEL', 'VISITOR', 'CONTRACTOR', 'TEMPORARY', 'VEHICLE', 'DELIVERY'] as const;
export type GateMode = (typeof GATE_MODES)[number];

export const VERIFICATION_METHODS = ['CREDENTIAL', 'MOCK_READER', 'QR', 'REFERENCE', 'PLATE', 'ADMIN_CORRECTION'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];
export const VERIFICATION_METHOD_LABEL: Record<VerificationMethod, string> = {
  CREDENTIAL: 'Credential (manual entry)',
  MOCK_READER: 'Mock reader (simulated)',
  QR: 'QR pass (simulated scan)',
  REFERENCE: 'Reference entered manually',
  PLATE: 'Registration number lookup',
  ADMIN_CORRECTION: 'Administrative correction',
};

// ---------------------------------------------------------------------------
// Verification results
// ---------------------------------------------------------------------------

export const RESULT_CODES = [
  'VERIFIED',
  'INVALID_CREDENTIAL',
  'INACTIVE_CREDENTIAL',
  'BLOCKED_CREDENTIAL',
  'LOST_CREDENTIAL',
  'EXPIRED_CREDENTIAL',
  'INACTIVE_PERSONNEL',
  'INACTIVE_RECORD',
  'EXPIRED_ACCESS',
  'REVOKED_ACCESS',
  'NOT_YET_VALID',
  'OUTSIDE_PERMITTED_HOURS',
  'WRONG_LOCATION',
  'INVALID_PASS',
  'EXPIRED_PASS',
  'CANCELLED_PASS',
  'NOT_APPROVED',
  'ALREADY_USED',
  'UNREGISTERED_VEHICLE',
  'BLOCKED_VEHICLE',
  'MANUAL_REVIEW_REQUIRED',
  'NOT_FOUND',
] as const;
export type ResultCode = (typeof RESULT_CODES)[number];

export const RESULT_INFO: Record<ResultCode, { label: string; tone: Tone }> = {
  VERIFIED: { label: 'Verified', tone: 'success' },
  INVALID_CREDENTIAL: { label: 'Invalid Credential', tone: 'danger' },
  INACTIVE_CREDENTIAL: { label: 'Inactive Credential', tone: 'danger' },
  BLOCKED_CREDENTIAL: { label: 'Blocked Credential', tone: 'danger' },
  LOST_CREDENTIAL: { label: 'Credential Reported Lost', tone: 'danger' },
  EXPIRED_CREDENTIAL: { label: 'Expired Credential', tone: 'danger' },
  INACTIVE_PERSONNEL: { label: 'Inactive Personnel', tone: 'danger' },
  INACTIVE_RECORD: { label: 'Inactive Record', tone: 'danger' },
  EXPIRED_ACCESS: { label: 'Expired Access', tone: 'danger' },
  REVOKED_ACCESS: { label: 'Access Revoked', tone: 'danger' },
  NOT_YET_VALID: { label: 'Not Yet Valid', tone: 'warning' },
  OUTSIDE_PERMITTED_HOURS: { label: 'Outside Permitted Hours', tone: 'warning' },
  WRONG_LOCATION: { label: 'Wrong Location', tone: 'danger' },
  INVALID_PASS: { label: 'Invalid Visitor Pass', tone: 'danger' },
  EXPIRED_PASS: { label: 'Expired Pass', tone: 'danger' },
  CANCELLED_PASS: { label: 'Cancelled Pass', tone: 'danger' },
  NOT_APPROVED: { label: 'Not Approved', tone: 'danger' },
  ALREADY_USED: { label: 'Already Used', tone: 'danger' },
  UNREGISTERED_VEHICLE: { label: 'Vehicle Not Registered', tone: 'warning' },
  BLOCKED_VEHICLE: { label: 'Blocked Vehicle', tone: 'danger' },
  MANUAL_REVIEW_REQUIRED: { label: 'Manual Review Required', tone: 'warning' },
  NOT_FOUND: { label: 'Record Not Found', tone: 'danger' },
};

/** Default result codes for which a guard may refer the case for manual review. */
export const DEFAULT_MANUAL_REVIEW_ELIGIBLE: ResultCode[] = [
  'MANUAL_REVIEW_REQUIRED',
  'OUTSIDE_PERMITTED_HOURS',
  'WRONG_LOCATION',
  'EXPIRED_ACCESS',
  'EXPIRED_CREDENTIAL',
  'INACTIVE_CREDENTIAL',
  'NOT_YET_VALID',
];

export const MANUAL_REVIEW_STATUSES = ['PENDING', 'APPROVED', 'DECLINED', 'USED', 'EXPIRED'] as const;
export type ManualReviewStatus = (typeof MANUAL_REVIEW_STATUSES)[number];
export const MANUAL_REVIEW_INFO: Record<ManualReviewStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending decision', tone: 'warning' },
  APPROVED: { label: 'Approved for one movement', tone: 'info' },
  DECLINED: { label: 'Declined', tone: 'danger' },
  USED: { label: 'Used', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
};

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const ALERT_TYPES = [
  'INVALID_CREDENTIAL',
  'EXPIRED_CREDENTIAL',
  'BLOCKED_CREDENTIAL',
  'CANCELLED_PASS',
  'INVALID_QR',
  'WRONG_LOCATION',
  'REPEATED_FAILED_VERIFICATION',
  'VISITOR_OVERSTAY',
  'UNCLOSED_VISIT',
  'INCONSISTENT_EVENT',
  'INCOMPLETE_DELIVERY_ACK',
  'UNRESOLVED_ADMIN_RECORD',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const ALERT_SEVERITY_TONE: Record<AlertSeverity, Tone> = {
  LOW: 'neutral',
  MEDIUM: 'warning',
  HIGH: 'danger',
  CRITICAL: 'danger',
};

export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];
export const ALERT_STATUS_INFO: Record<AlertStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'Open', tone: 'danger' },
  ACKNOWLEDGED: { label: 'Acknowledged', tone: 'warning' },
  RESOLVED: { label: 'Resolved', tone: 'success' },
};

export const ALERT_TYPE_INFO: Record<AlertType, { label: string; defaultSeverity: AlertSeverity }> = {
  INVALID_CREDENTIAL: { label: 'Invalid credential', defaultSeverity: 'MEDIUM' },
  EXPIRED_CREDENTIAL: { label: 'Expired credential', defaultSeverity: 'LOW' },
  BLOCKED_CREDENTIAL: { label: 'Blocked credential presented', defaultSeverity: 'HIGH' },
  CANCELLED_PASS: { label: 'Cancelled visitor pass presented', defaultSeverity: 'MEDIUM' },
  INVALID_QR: { label: 'Invalid QR token', defaultSeverity: 'MEDIUM' },
  WRONG_LOCATION: { label: 'Wrong location', defaultSeverity: 'MEDIUM' },
  REPEATED_FAILED_VERIFICATION: { label: 'Repeated failed verification', defaultSeverity: 'HIGH' },
  VISITOR_OVERSTAY: { label: 'Visitor overstay', defaultSeverity: 'MEDIUM' },
  UNCLOSED_VISIT: { label: 'Unclosed visit', defaultSeverity: 'MEDIUM' },
  INCONSISTENT_EVENT: { label: 'Duplicate or inconsistent event', defaultSeverity: 'MEDIUM' },
  INCOMPLETE_DELIVERY_ACK: { label: 'Incomplete delivery acknowledgement', defaultSeverity: 'LOW' },
  UNRESOLVED_ADMIN_RECORD: { label: 'Unresolved administrative record', defaultSeverity: 'LOW' },
};

// ---------------------------------------------------------------------------
// Administrative exceptions
// ---------------------------------------------------------------------------

export const EXCEPTION_CATEGORIES = [
  'RECORD_DISCREPANCY',
  'MISSING_EXIT',
  'EVENT_CORRECTION',
  'MANUAL_REVIEW',
  'CREDENTIAL_ISSUE',
  'VISITOR_ISSUE',
  'DELIVERY_ISSUE',
  'OTHER',
] as const;
export type ExceptionCategory = (typeof EXCEPTION_CATEGORIES)[number];
export const EXCEPTION_CATEGORY_LABEL: Record<ExceptionCategory, string> = {
  RECORD_DISCREPANCY: 'Record discrepancy',
  MISSING_EXIT: 'Missing exit record',
  EVENT_CORRECTION: 'Event correction',
  MANUAL_REVIEW: 'Manual review follow-up',
  CREDENTIAL_ISSUE: 'Credential issue',
  VISITOR_ISSUE: 'Visitor record issue',
  DELIVERY_ISSUE: 'Delivery record issue',
  OTHER: 'Other administrative matter',
};

export const EXCEPTION_STATUSES = ['OPEN', 'UNDER_REVIEW', 'RESOLVED'] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];
export const EXCEPTION_STATUS_INFO: Record<ExceptionStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'Open', tone: 'danger' },
  UNDER_REVIEW: { label: 'Under Review', tone: 'warning' },
  RESOLVED: { label: 'Resolved', tone: 'success' },
};
export const EXCEPTION_TRANSITIONS: Record<ExceptionStatus, ExceptionStatus[]> = {
  OPEN: ['UNDER_REVIEW', 'RESOLVED'],
  UNDER_REVIEW: ['RESOLVED', 'OPEN'],
  RESOLVED: [],
};

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export const GATE_TYPES = ['MAIN', 'PEDESTRIAN', 'VEHICLE', 'SERVICE'] as const;
export type GateType = (typeof GATE_TYPES)[number];
export const GATE_TYPE_LABEL: Record<GateType, string> = {
  MAIN: 'Main gate',
  PEDESTRIAN: 'Pedestrian gate',
  VEHICLE: 'Vehicle gate',
  SERVICE: 'Service / delivery gate',
};

// ---------------------------------------------------------------------------
// Misc helpers shared by client & server
// ---------------------------------------------------------------------------

export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const DEMO_BANNER_TEXT =
  'Demonstration mode — all records are synthetic and all verification is simulated. Not connected to any operational system or access-control hardware.';
