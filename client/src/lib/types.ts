import type { Permission, RoleCode } from '../../../shared/constants';

export interface AppConfigInfo {
  appName: string;
  mode: 'demo' | 'production';
  demo: boolean;
  demoBanner: string | null;
  timezone: string;
  sessionIdleMinutes: number;
  demoAccounts: { username: string; displayName: string; role: RoleCode; roleName: string; designation: string | null; locationName: string | null }[];
}

export interface GateInfo {
  id: number;
  locationId: number;
  code: string;
  name: string;
  gateType: string;
}

export interface LocationInfo {
  id: number;
  code: string;
  name: string;
  kind: 'HQ' | 'LOCATION';
  gates: GateInfo[];
}

export interface Me {
  user: {
    id: number;
    username: string;
    displayName: string;
    role: RoleCode;
    roleName: string;
    designation: string | null;
    department: string | null;
    isDemo: boolean;
    allLocations: boolean;
    primaryLocationId: number | null;
    assignedGateId: number | null;
  };
  permissions: Permission[];
  locations: LocationInfo[];
  options: {
    vehicleCategories: { code: string; label: string }[];
    deliveryCategories: { code: string; label: string }[];
    visitTransitions: Record<string, string[]>;
    requireSecurityCheck: boolean;
    manualReviewEligible: string[];
    verificationTtlSeconds: number;
  };
  session: { idleMinutes: number };
}

export type Row = Record<string, any>;
